// capability model. mirrors the frontend, but this is the authoritative copy.
export const roles = ["owner", "admin", "delegate", "reviewer", "documents", "member"] as const;
export type Role = (typeof roles)[number];
export type Cap = "publish" | "review" | "documents" | "members" | "settings" | "analytics" | "wallet";
export const caps: Record<Role, Cap[]> = {
  owner: ["publish", "review", "documents", "members", "settings", "analytics", "wallet"],
  admin: ["publish", "review", "documents", "members", "analytics"],
  delegate: ["publish"], reviewer: ["review"], documents: ["documents"], member: [],
};
/** a role gives a base set of capabilities. owners can grant individual members extra ones. */
export const can = (role: Role | undefined, cap: Cap, grants?: readonly string[]) => !!role && (caps[role].includes(cap) || !!grants?.includes(cap));
export const capList = Object.keys(caps.owner.reduce((o, c) => ({ ...o, [c]: 1 }), {})) as Cap[];
