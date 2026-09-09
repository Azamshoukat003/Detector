import type { NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example and the README.`,
    );
  }
  return value;
}

export const authOptions: NextAuthOptions = {
  providers: [
    GitHubProvider({
      clientId: required("GITHUB_ID"),
      clientSecret: required("GITHUB_SECRET"),
      // GitHub now returns an `iss` parameter on the OAuth callback. Under the
      // hood next-auth hands the callback to openid-client, which refuses to
      // validate `iss` unless the issuer is configured — next-auth's own GitHub
      // provider leaves it undefined, so the callback dies with
      // "issuer must be configured on the issuer". This must match the `iss`
      // GitHub sends verbatim.
      issuer: "https://github.com/login/oauth",
      authorization: {
        // read:user  -> profile for the header
        // repo       -> read repo contents INCLUDING PRIVATE REPOS.
        //               See the security note in the README before signing in.
        params: { scope: "read:user repo" },
      },
    }),
  ],
  // No database in v1: the session (and the GitHub token) lives only in the
  // encrypted NextAuth JWT cookie.
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account?.access_token) token.accessToken = account.access_token;
      const login = (profile as { login?: string } | undefined)?.login;
      if (login) token.login = login;
      return token;
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken;
      if (session.user) session.user.login = token.login;
      return session;
    },
  },
  pages: {
    signIn: "/",
  },
};
