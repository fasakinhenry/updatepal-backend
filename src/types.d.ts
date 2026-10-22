import type { Role } from "@/core/caps";
declare global {
  namespace Express {
    interface Request { userId?: string; role?: Role; grants?: string[]; channels?: string[] }
  }
}
export {};
