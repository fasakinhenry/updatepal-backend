import { Block } from "@/modules/messages/routes";
import { Session, OneTimeToken, User } from "@/modules/auth/models";
import { Membership } from "@/modules/orgs/models";
import { Celebration, Story } from "@/modules/stories/models";
import { Bookmark, Comment, Follow, Reaction } from "@/modules/updates/models";

/** removes a person and the things only they own. used by self deletion and by the admin. */
export async function purgeUser(id: string) {
  await Promise.all([Session.deleteMany({ user: id }), OneTimeToken.deleteMany({ user: id }), Membership.deleteMany({ user: id }), Follow.deleteMany({ follower: id }), Bookmark.deleteMany({ user: id }), Reaction.deleteMany({ user: id }), Celebration.deleteMany({ user: id }), Story.deleteMany({ author: id }), Comment.deleteMany({ author: id }), Block.deleteMany({ $or: [{ blocker: id }, { blocked: id }] })]);
  await User.deleteOne({ _id: id });
}
