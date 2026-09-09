import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import SignInGate from "@/components/SignInGate";
import Dashboard from "@/components/Dashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getServerSession(authOptions);

  if (!session?.accessToken) {
    return <SignInGate />;
  }

  return (
    <Dashboard
      login={session.user?.login ?? session.user?.name ?? "signed in"}
      avatarUrl={session.user?.image ?? null}
    />
  );
}
