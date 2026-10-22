import { storage } from "@/core/storage";
import { Doc } from "@/modules/documents/routes";
import { Draft } from "@/modules/publishing/routes";
import { Comment, Follow, Update } from "@/modules/updates/models";
import { Invitation, Membership, Org } from "./models";

/** deletes an organization with its updates, drafts, documents (and stored files), members and invitations. */
export async function purgeOrg(org: InstanceType<typeof Org>) {
  const files = await Doc.find({ org: org._id, storageKey: { $exists: true } }, "storageKey");
  await Promise.all(files.map((f) => (f.storageKey ? storage.remove(f.storageKey) : undefined)));
  const ups = await Update.find({ org: org._id }, "_id");
  await Promise.all([Comment.deleteMany({ update: { $in: ups.map((u) => u._id) } }), Update.deleteMany({ org: org._id }), Draft.deleteMany({ org: org._id }), Doc.deleteMany({ org: org._id }), Invitation.deleteMany({ org: org._id }), Membership.deleteMany({ org: org._id }), Follow.deleteMany({ kind: "org", target: String(org._id) })]);
  await org.deleteOne();
}
