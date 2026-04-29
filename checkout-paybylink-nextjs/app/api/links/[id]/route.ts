import { NextResponse } from "next/server";
import { getLink } from "@/lib/storage";

// Auth: intentionally unauthenticated for local-dev convenience. Gate behind
// session / Bearer auth before deploying — response includes `checkoutUrl`,
// which is a bearer token for the hosted checkout.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const link = getLink(id);
  if (!link) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(link);
}
