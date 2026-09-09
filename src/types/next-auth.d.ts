import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    /** GitHub OAuth access token, forwarded from the JWT. */
    accessToken?: string;
    /** Non-fatal auth problem to surface in the UI (e.g. token revoked). */
    error?: string;
    user: {
      login?: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    login?: string;
  }
}
