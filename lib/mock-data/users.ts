import type { User } from "@/lib/types";

export const users: User[] = [
  { id: "u1", name: "Priya Raman", initials: "PR", email: "priya.raman@meridiancapital.com", color: "#4F46E5" },
  { id: "u2", name: "Marcus Chen", initials: "MC", email: "marcus.chen@meridiancapital.com", color: "#0EA5E9" },
  { id: "u3", name: "Sofia Alvarez", initials: "SA", email: "sofia.alvarez@meridiancapital.com", color: "#059669" },
  { id: "u4", name: "David Okafor", initials: "DO", email: "david.okafor@meridiancapital.com", color: "#D97706" },
  { id: "u5", name: "Elena Petrova", initials: "EP", email: "elena.petrova@meridiancapital.com", color: "#DB2777" },
  { id: "u6", name: "James Whitfield", initials: "JW", email: "james.whitfield@meridiancapital.com", color: "#7C3AED" },
  { id: "u7", name: "Aisha Khan", initials: "AK", email: "aisha.khan@meridiancapital.com", color: "#0891B2" },
  { id: "u8", name: "Tom Brennan", initials: "TB", email: "tom.brennan@meridiancapital.com", color: "#65A30D" },
];

export function getUser(id: string | null): User | null {
  if (!id) return null;
  return users.find((u) => u.id === id) ?? null;
}
