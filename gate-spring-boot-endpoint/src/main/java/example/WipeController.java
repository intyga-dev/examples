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
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/** A REST endpoint that will not wipe a database until a human signs off on the exact one. */
@RestController
public class WipeController {

  // The execution target — who THIS service is. Bound into the signed payload (DIV Target
  // Isolation) so an approval minted for another service cannot be replayed here.
  private static final String TARGET = env("INTYGA_TARGET", "prod-db-cluster-01");

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

  @DeleteMapping("/databases/{name}")
  public Map<String, Object> wipe(@PathVariable String name) {
    Map<String, Object> params = Map.of("database", name);

    // Blocks this request thread until a human approves with their passkey (default wait 120s).
    // Any other outcome throws ApprovalRefusedException — handled below as a 403, so a refusal
    // can never fall through to the wipe.
    ApprovalResult approval =
        intyga.requireApprovalOrThrow(
            "Delete production database " + name,
            RequireApprovalOptions.builder()
                .authorize(
                    AuthorizeOptions.builder()
                        .target(TARGET)
                        .actionType("wipe_production")
                        .params(params)
                        .build())
                .build());

    // Verify the receipt in this process before doing anything irreversible: the gateway said
    // APPROVED, and this is the check that does not have to take its word for it.
    VerifyResult check = Verify.verifyApprovalReceipt(
        ApprovalReceipt.parse(approval.receipt()),
        new Expected(TARGET, approval.nonce(), "wipe_production", params,
            ApproverTrustAnchor.ofPublicKeys(APPROVER_KEYS)),
        VerifyOptions.defaults());
    if (!check.ok()) {
      throw new ApprovalRefusedException(ApprovalStatus.DENIED, "receipt did not verify: " + check.reason());
    }

    // Redeem exactly once, with the SAME params map that was gated: the approved params are
    // exactly what executes. The gateway refuses if anything drifted since the signature.
    ConsumeResult consumed = intyga.consume(approval.nonce(), TARGET, "wipe_production", params);
    if (!consumed.ok()) {
      throw new ApprovalRefusedException(
          ApprovalStatus.CONSUMED, "the approval could not be redeemed");
    }

    return Map.of(
        "dropped", name,
        "pretend", true,
        "approvalNonce", approval.nonce(),
        "signers", check.signers());
  }

  /** Refusal is an exception, never a 200 — the human's "no" surfaces as a 403 with the status. */
  @ExceptionHandler(ApprovalRefusedException.class)
  public ResponseEntity<Map<String, String>> refused(ApprovalRefusedException e) {
    return ResponseEntity.status(HttpStatus.FORBIDDEN)
        .body(Map.of("error", "not authorized", "status", e.status().name()));
  }

  private static String env(String name, String fallback) {
    String value = System.getenv(name);
    return value == null || value.isEmpty() ? fallback : value;
  }
}
