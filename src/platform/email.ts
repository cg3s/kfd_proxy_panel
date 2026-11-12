import nodemailer from "nodemailer";
import type { Config } from "../config";

export async function sendVerificationEmail(config: Config, email: string, code: string): Promise<void> {
  if (!config.smtpHost || !config.smtpFrom) {
    throw new Error("SMTP_HOST and SMTP_FROM must be configured to send verification emails");
  }
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
  });
  await transport.sendMail({
    from: config.smtpFrom,
    to: email,
    subject: "卡付达平台邮箱验证码",
    text: `你的邮箱验证码是 ${code}，10 分钟内有效。若非本人操作，请忽略此邮件。`,
  });
}
