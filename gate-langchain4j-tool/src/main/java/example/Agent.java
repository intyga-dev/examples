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
import dev.langchain4j.agent.tool.P;
import dev.langchain4j.agent.tool.Tool;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.service.AiServices;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * Gate a LangChain4j agent tool behind a real human approval.
 *
 * <p>No per-framework adapter: every agent framework reduces a tool to a method call, so the gate
 * is one {@code requireApprovalOrThrow} as the method's first statement — the Java shape of
 * sdk-python's {@code require_human_approval} guard. Refusal is an exception, never a return
 * value, so the framework cannot mistake "the human said no" for a tool result.
 */
public final class Agent {

  // The execution target — who THIS agent runtime is. Bound into the signed payload
  // (DIV Target Isolation) so an approval minted for another service cannot be replayed here.
  private static final String TARGET = env("INTYGA_TARGET", "agent-payments-prod");

  // The approver keys THIS runtime trusts, resolved from its own key management — never the key
  // inside the receipt, which would let a receipt vouch for its own signer.
  private static final List<String> APPROVER_KEYS =
      Arrays.stream(env("INTYGA_APPROVER_KEYS", "").split(",")).filter(k -> !k.isBlank()).toList();

  private static final IntygaClient INTYGA =
      IntygaClient.builder()
          .gatewayUrl(env("INTYGA_GATEWAY_URL", "http://localhost:8787"))
          .clientId(System.getenv("INTYGA_CLIENT_ID"))
          .clientSecret(System.getenv("INTYGA_CLIENT_SECRET"))
          .build();

  public static class PaymentTools {

    @Tool("Wire money to a recipient account")
    public String wireTransfer(
        @P("amount in EUR") int amount, @P("recipient account") String to) {
      // The params the approver sees and signs are EXACTLY the tool arguments that execute —
      // whatever the model hallucinated or a prompt injection smuggled in is what the human reads.
      Map<String, Object> params = Map.of("amount", amount, "to", to);

      ApprovalResult approval =
          INTYGA.requireApprovalOrThrow(
              "Wire " + amount + " EUR to " + to,
              RequireApprovalOptions.builder()
                  .authorize(
                      AuthorizeOptions.builder()
                          .target(TARGET)
                          .actionType("wire_transfer")
                          .params(params)
                          .build())
                  .build());

      // Verify offline that a human signed THESE arguments. Without this, a compromised gateway
      // could approve a transfer the human never saw — the receipt is the evidence, and evidence
      // you do not check is not evidence.
      VerifyResult check = Verify.verifyApprovalReceipt(
          ApprovalReceipt.parse(approval.receipt()),
          new Expected(TARGET, approval.nonce(), "wire_transfer", params,
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

      // Redeem exactly once, with the same params — the gateway refuses anything that drifted
      // between the signature and execution.
      ConsumeResult consumed = INTYGA.consume(approval.nonce(), TARGET, "wire_transfer", params);
      if (!consumed.ok()) {
        throw new ApprovalRefusedException(
            ApprovalStatus.CONSUMED, "the approval could not be redeemed");
      }

      return "[pretend] wired " + amount + " EUR to " + to
          + " (approved by " + String.join(", ", check.signers()) + ")";
    }
  }

  interface Assistant {
    String chat(String message);
  }

  public static void main(String[] args) {
    String prompt = args.length > 0 ? String.join(" ", args) : "Wire 5000 EUR to acme-gmbh";

    String openAiKey = System.getenv("OPENAI_API_KEY");
    if (openAiKey == null || openAiKey.isEmpty()) {
      // No LLM credentials required to see the gate work: invoke the tool method directly —
      // the approval ceremony is identical either way.
      System.out.println(new PaymentTools().wireTransfer(5000, "acme-gmbh"));
      return;
    }

    Assistant assistant =
        AiServices.builder(Assistant.class)
            .chatModel(
                OpenAiChatModel.builder().apiKey(openAiKey).modelName("gpt-4.1-mini").build())
            .tools(new PaymentTools())
            .build();
    System.out.println(assistant.chat(prompt));
  }

  private static String env(String name, String fallback) {
    String value = System.getenv(name);
    return value == null || value.isEmpty() ? fallback : value;
  }

  private Agent() {}
}
