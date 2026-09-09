import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };

// The OAuth handler reads cookies and query params on every call, so it can
// never be static. Declaring that explicitly also keeps Next's dev
// static-paths worker from loading this route outside the compilation that
// produced its vendor chunks, which fails with
// "Cannot find module './vendor-chunks/next-auth.js'".
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
