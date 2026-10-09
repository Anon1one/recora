import Link from "next/link";
import { Brand } from "@/components/console";
export default function Guide() {
  return (
    <div className="checkout-shell">
      <header>
        <Brand />
        <Link href="/">Back to workspace →</Link>
      </header>
      <main id="main-content" tabIndex={-1} className="guide">
        <h1>A cycle you can follow.</h1>
        <section>
          <h2>Pull, review, settle.</h2>
          <p>
            A subscription approves a bounded number of cycles. The
            permissionless keeper pulls each payment into its subscription
            vault. During the review window, the subscriber may open a dispute
            by posting a bond. After the window, an undisputed charge settles to
            the merchant and protocol treasury.
          </p>
        </section>
        <section>
          <h2>Disputes have a deadline.</h2>
          <p>
            A merchant can refund a charge or contest a dispute with a matching
            bond. A contested charge goes to the plan’s resolver, who decides a
            merchant/subscriber split. If the merchant or resolver misses their
            deadline, the keeper refunds the charge and returns the posted
            bonds.
          </p>
        </section>
        <section>
          <h2>Your app receives the record.</h2>
          <p>
            Create a merchant webhook in Integrations. Deliveries include a
            stable event ID and a Recora-Signature header containing a timestamp
            and HMAC-SHA256 signature. Verify the signature against the exact
            body, reject stale timestamps, and deduplicate the event ID before
            granting or revoking access. Delivery is at least once.
          </p>
          <p>
            Use a read API key as an Authorization bearer token for merchant
            subscriptions, charges, and analytics. Keep it in your application’s
            server environment.
          </p>
        </section>
        <section>
          <h2>Start your environment.</h2>
          <p>
            Configure a Neon database and your deployed Recora program. Start
            the Next.js app and job scheduler, and point a Helius raw devnet
            webhook at the publicly reachable receiver. Keep the existing keeper
            running to bill and settle subscriptions.
          </p>
          <p>
            Full commands and API contracts are documented in{" "}
            <code>docs/APPLICATION.md</code> in the repository.
          </p>
        </section>
      </main>
    </div>
  );
}
