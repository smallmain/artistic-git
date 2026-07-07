import { describe, expect, it } from "vitest";

import { validateGitUser } from "./settings-model";

describe("validateGitUser", () => {
  it("requires author name and email", () => {
    expect(validateGitUser({ name: null, email: null })).toMatchObject({
      emailMissing: true,
      nameMissing: true,
      valid: false,
      messageKey: "settings.general.identityRequired",
    });
  });

  it("rejects malformed author email", () => {
    expect(
      validateGitUser({ name: "Art User", email: "artist@example" }),
    ).toMatchObject({
      emailInvalid: true,
      emailMissing: false,
      nameMissing: false,
      valid: false,
      messageKey: "settings.general.emailInvalid",
    });
  });

  it("accepts complete author identity", () => {
    expect(
      validateGitUser({ name: "Art User", email: "artist@example.test" }),
    ).toMatchObject({
      emailInvalid: false,
      emailMissing: false,
      nameMissing: false,
      valid: true,
      messageKey: null,
    });
  });
});
