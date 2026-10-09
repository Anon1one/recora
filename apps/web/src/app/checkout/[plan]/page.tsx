import { Checkout } from "@/components/checkout";
export default async function Page({
  params,
}: {
  params: Promise<{ plan: string }>;
}) {
  return <Checkout plan={(await params).plan} />;
}
