import { describe, expect, it } from "vitest";
import { personName, TEAM_MEMBER } from "@/server/content/person-name";

describe("personName", () => {
  it("uses the trimmed name when there is one, whoever asks", () => {
    expect(personName({ name: "  Ana Ruiz ", email: "ana@x.com" }, { reveal: false })).toBe("Ana Ruiz");
    expect(personName({ name: "Ana", email: "ana@x.com" }, { reveal: true })).toBe("Ana");
  });

  it("falls back to the email's local part only for people who manage members", () => {
    expect(personName({ name: null, email: "bob.smith@x.com" }, { reveal: true })).toBe("bob.smith");
    expect(personName({ name: "   ", email: "bob.smith@x.com" }, { reveal: true })).toBe("bob.smith");
  });

  it("says 'A team member' to everyone else, never any part of the email", () => {
    expect(TEAM_MEMBER).toBe("A team member");
    expect(personName({ name: null, email: "bob.smith@x.com" }, { reveal: false })).toBe("A team member");
    expect(personName({ name: "  ", email: "bob.smith@x.com" }, { reveal: false })).toBe("A team member");
  });
});
