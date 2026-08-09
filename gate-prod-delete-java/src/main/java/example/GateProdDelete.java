package example;

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

/**
 * Gate a production database deletion behind a signed human approval.
 *
 * <p>Run: {@code INTYGA_CLIENT_ID=... INTYGA_CLIENT_SECRET=... mvn compile exec:java
 * -Dexec.args="prod-db-1"}. Passing a SECOND argument simulates parameter drift between what was
 * approved and what executes — the gateway-side re-binding in consume() is what catches it.
 */
public final class GateProdDelete {

  public static void main(String[] args) {
    String approvedDatabase = args.length > 0 ? args[0] : "prod-db-1";
    String executedDatabase = args.length > 1 ? args[1] : approvedDatabase;

    // The execution target — who WE are. Bound into the signed payload (DIV Target Isolation) so
    // an approval minted for another service cannot be replayed here.
    String target = env("INTYGA_TARGET", "prod-db-cluster-01");

    // The approver keys THIS caller trusts, resolved from our own key management. Never the key
    // inside the receipt: a receipt checked against its own embedded key proves nothing. There is
    // deliberately no default.
    List<String> approverKeys =
        Arrays.stream(env("INTYGA_APPROVER_KEYS", "").split(","))
            .filter(k -> !k.isBlank())
            .toList();
    if (approverKeys.isEmpty()) {
      System.err.println("Set INTYGA_APPROVER_KEYS to one or more base64 approver public keys.");
      System.exit(1);
    }

    IntygaClient intyga =
        IntygaClient.builder()
            .gatewayUrl(env("INTYGA_GATEWAY_URL", "http://localhost:8787"))
            .clientId(System.getenv("INTYGA_CLIENT_ID"))
            .clientSecret(System.getenv("INTYGA_CLIENT_SECRET"))
            .build();

    Map<String, Object> approvedParams = Map.of("database", approvedDatabase);

    System.out.println(
        "Requesting human approval to wipe "
            + approvedDatabase
            + " … (approve with a passkey or security key)");
    ApprovalResult approval =
        intyga.requireApproval(
            "Delete production database " + approvedDatabase,
            RequireApprovalOptions.builder()
                .authorize(
                    AuthorizeOptions.builder()
                        .target(target)
                        .actionType("wipe_production")
                        .params(approvedParams)
                        .build())
                .build());

    if (approval.status() != ApprovalStatus.APPROVED) {
      System.err.println(
          "❌ Not authorized: " + approval.status() + ". Aborting — nothing was deleted.");
      System.exit(1);
    }

    // Prove locally that a human signed off on THIS exact instruction (no Intyga secret).
    // target, nonce and approvers are asserted from OUR side, never read from the receipt.
    VerifyResult check = Verify.verifyApprovalReceipt(
        ApprovalReceipt.parse(approval.receipt()),
        new Expected(
            target,
            approval.nonce(),
            "wipe_production",
            approvedParams,
            ApproverTrustAnchor.ofPublicKeys(approverKeys)),
        VerifyOptions.defaults());
    if (!check.ok()) {
      System.err.println("❌ Receipt did not verify: " + check.reason() + ". Aborting.");
      System.exit(1);
    }
    System.out.println("✅ Verified approval — signed by " + String.join(", ", check.signers()));

    // Redeem it exactly once, immediately before the action runs. This is the gateway-side
    // re-binding that makes the approval single-use; the offline check above is what means you
    // don't have to trust the gateway for the content.
    ConsumeResult consumed =
        intyga.consume(
            approval.nonce(), target, "wipe_production", Map.of("database", executedDatabase));
    if (!consumed.ok()) {
      System.err.println(
          "❌ The gateway refused to redeem the approval"
              + (consumed.reason() == null ? "" : " (" + consumed.reason() + ")")
              + ". Aborting — nothing was deleted.");
      System.exit(1);
    }

    reallyDropTheDatabase(executedDatabase);
    System.out.println("Done.");
  }

  // The one dangerous thing we never want to happen unsupervised.
  private static void reallyDropTheDatabase(String database) {
    System.out.println("💥 [pretend] dropping database " + database + " …");
  }

  private static String env(String name, String fallback) {
    String value = System.getenv(name);
    return value == null || value.isEmpty() ? fallback : value;
  }

  private GateProdDelete() {}
}
