import { NextResponse } from "next/server";
import { getLink } from "@/lib/storage";

// Auth: proxy.ts guards this route (ADMIN_TOKEN), and in production refuses
// every request until ADMIN_TOKEN is set. The response includes `checkoutUrl`,
// which is a bearer token for the hosted checkout.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const link = getLink(id);
  if (!link) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(link);
}
