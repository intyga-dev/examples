package example;

import com.intyga.sdk.ApprovalRefusedException;
import com.intyga.sdk.ApprovalResult;
import com.intyga.sdk.ApprovalStatus;
import com.intyga.sdk.AuthorizeOptions;
import com.intyga.sdk.ConsumeResult;
import com.intyga.sdk.IntygaClient;
import com.intyga.sdk.RequireApprovalOptions;
import com.intyga.verify.ApprovalReceipt;
import com.intyga.verify.ApproverTrustAnchor;
import com.intyga.verify.Expected;
import com.intyga.verify.Verify;
import com.intyga.verify.VerifyOptions;
import com.intyga.verify.VerifyResult;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.ext.ExceptionMapper;
import jakarta.ws.rs.ext.Provider;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/** A deploy endpoint that will not roll production until a human signs off on the exact SHA. */
@Path("/deploy")
public class DeployResource {

  // The execution target — who THIS service is. Bound into the signed payload (DIV Target
  // Isolation) so an approval minted for another service cannot be replayed here.
  private static final String TARGET = env("INTYGA_TARGET", "prod-cluster-01");

  // The approver keys THIS service trusts, resolved from its own key management — never the key
  // inside the receipt, which would let a receipt vouch for its own signer.
  private static final List<String> APPROVER_KEYS =
      Arrays.stream(env("INTYGA_APPROVER_KEYS", "").split(",")).filter(k -> !k.isBlank()).toList();

  private final IntygaClient intyga =
      IntygaClient.builder()
          .gatewayUrl(env("INTYGA_GATEWAY_URL", "http://localhost:8787"))
          .clientId(System.getenv("INTYGA_CLIENT_ID"))
          .clientSecret(System.getenv("INTYGA_CLIENT_SECRET"))
          .build();

  public record DeployRequest(String repo, String sha) {}

  @POST
  @Consumes(MediaType.APPLICATION_JSON)
  @Produces(MediaType.APPLICATION_JSON)
  public Map<String, Object> deploy(DeployRequest request) {
    Map<String, Object> params = Map.of("repo", request.repo(), "sha", request.sha());

    // Blocks until a human approves with their passkey (default wait 120s). Any other outcome
    // throws ApprovalRefusedException — mapped below to a 403, so a refusal can never fall
    // through to the deploy.
    ApprovalResult approval =
        intyga.requireApprovalOrThrow(
            "Deploy " + request.repo() + " @ " + request.sha() + " to production",
            RequireApprovalOptions.builder()
                .authorize(
                    AuthorizeOptions.builder()
                        .target(TARGET)
                        .actionType("deploy_production")
                        .params(params)
                        .build())
                .build());

    // Verify the receipt in this process before shipping anything: the gateway said APPROVED, and
    // this is the check that does not have to take its word for it.
    VerifyResult check = Verify.verifyApprovalReceipt(
        ApprovalReceipt.parse(approval.receipt()),
        new Expected(TARGET, approval.nonce(), "deploy_production", params,
            ApproverTrustAnchor.ofPublicKeys(APPROVER_KEYS)),
        // REQUIRED for passkey receipts (the normal flow): pin the assertion to the approval
        // console the human signed in — your deployment's WEBAUTHN_ORIGIN / WEBAUTHN_RP_ID.
        // The verifier fails closed without them.
        VerifyOptions.builder()
            .expectedOrigin(System.getenv("INTYGA_WEBAUTHN_ORIGIN"))
            .expectedRpId(System.getenv("INTYGA_WEBAUTHN_RP_ID"))
            .build());
    if (!check.ok()) {
      throw new ApprovalRefusedException(
          ApprovalStatus.DENIED, "receipt did not verify: " + check.reason());
    }

    // Redeem exactly once, with the SAME params that were gated: the approved SHA is exactly what
    // ships. The gateway refuses if anything drifted since the signature.
    ConsumeResult consumed = intyga.consume(approval.nonce(), TARGET, "deploy_production", params);
    if (!consumed.ok()) {
      throw new ApprovalRefusedException(
          ApprovalStatus.CONSUMED, "the approval could not be redeemed");
    }

    return Map.of(
        "deployed", request.sha(),
        "pretend", true,
        "approvalNonce", approval.nonce(),
        "signers", check.signers());
  }

  /** Refusal is an exception, never a 200 — the human's "no" surfaces as a 403 with the status. */
  @Provider
  public static class RefusedMapper implements ExceptionMapper<ApprovalRefusedException> {
    @Override
    public Response toResponse(ApprovalRefusedException e) {
      return Response.status(Response.Status.FORBIDDEN)
          .entity(Map.of("error", "not authorized", "status", e.status().name()))
          .build();
    }
  }

  private static String env(String name, String fallback) {
    String value = System.getenv(name);
    return value == null || value.isEmpty() ? fallback : value;
  }
}
