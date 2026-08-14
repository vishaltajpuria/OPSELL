import { redirect } from "next/navigation";
import { isConnected } from "@/lib/session";

export default function Home() {
  redirect(isConnected() ? "/stocks" : "/settings");
}
