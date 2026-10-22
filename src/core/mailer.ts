import { Resend } from "resend";
import { env, isProd } from "./env";

const client = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
/** sends through resend. without an api key, emails are logged in development only. */
export async function sendMail(to: string, subject: string, text: string) {
  if (!client) { if (!isProd) console.log(`[mail to ${to}] ${subject}\n${text}\n`); return; }
  const { error } = await client.emails.send({ from: env.MAIL_FROM, to, subject, text });
  if (error) console.error("mail failed", error.message);
}
