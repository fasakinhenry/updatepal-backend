import { Router } from "express";
import { encryptionReady } from "@/core/crypto";
import { env } from "@/core/env";
import { settings } from "@/core/settings";
import { hasPayments, providerList } from "@/modules/payments/provider";

// public runtime config: banner, maintenance flag, and which optional features are available
export const systemRoutes = Router();
systemRoutes.get("/config", async (_req, res) => {
  const s = await settings();
  res.json({
    announcement: s.announcement, maintenance: s.maintenance, registrationOpen: s.registrationOpen,
    payments: {
      enabled: hasPayments && s.tippingEnabled, feeBps: s.platformFeeBps, withdrawals: encryptionReady,
      providers: providerList.map((p) => ({ id: p.name, label: p.name === "paypal" ? "paypal" : "card or bank transfer", currency: p.currency, minTipMinor: p.name === "paypal" ? s.minTipPaypalMinor : s.minTipKobo, batch: p.batch })),
      withdrawalMethods: [{ id: "bank", currency: env.PAYMENT_CURRENCY, minMinor: s.minWithdrawalKobo }, { id: "paypal", currency: env.PAYPAL_CURRENCY, minMinor: s.minWithdrawalPaypalMinor }],
    },
  });
});
