import { notFound } from "next/navigation";
import { Console } from "@/components/console";
export default async function Page({
  params,
}: {
  params: Promise<{ view: string[] }>;
}) {
  const view = (await params).view.join("/");
  if (
    ![
      "merchant/plans",
      "merchant/subscriptions",
      "merchant/charges",
      "merchant/integrations",
      "subscriptions",
      "resolver",
      "admin",
    ].includes(view)
  )
    notFound();
  return <Console view={view} />;
}
