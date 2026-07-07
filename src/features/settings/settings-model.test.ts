import { describe, expect, it } from "vitest";

import {
  defaultAppSettings,
  identityRepositoryPaths,
  sameGitUser,
  settingsWithFetchPreferences,
  settingsWithGitUser,
  validateFetchIntervalSeconds,
  validateGitUser,
} from "./settings-model";

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

  it("deduplicates open repository paths for identity application", () => {
    expect(
      identityRepositoryPaths([" /repo/one ", null, "/repo/two", "/repo/one"]),
    ).toEqual(["/repo/one", "/repo/two"]);
  });

  it("compares cleaned author identity across settings updates", () => {
    const current = settingsWithGitUser(defaultAppSettings, {
      name: " Art User ",
      email: "art@example.test",
    });
    const next = settingsWithGitUser(defaultAppSettings, {
      name: "Art User",
      email: " art@example.test ",
    });
    const changed = settingsWithGitUser(defaultAppSettings, {
      name: "Other User",
      email: "art@example.test",
    });

    expect(sameGitUser(current, next)).toBe(true);
    expect(sameGitUser(current, changed)).toBe(false);
  });
});

describe("fetch interval settings", () => {
  it("validates the supported 10-3600 second range", () => {
    expect(validateFetchIntervalSeconds(10)).toMatchObject({ valid: true });
    expect(validateFetchIntervalSeconds(3600)).toMatchObject({ valid: true });
    expect(validateFetchIntervalSeconds(9)).toMatchObject({ valid: false });
    expect(validateFetchIntervalSeconds(3601)).toMatchObject({ valid: false });
  });

  it("updates fetch preferences without touching author identity", () => {
    const current = settingsWithGitUser(defaultAppSettings, {
      email: "art@example.test",
      name: "Art User",
    });
    const next = settingsWithFetchPreferences(current, {
      autoFetch: false,
      fetchIntervalSeconds: 120,
    });

    expect(next.git?.autoFetch).toBe(false);
    expect(next.git?.fetchIntervalSeconds).toBe(120);
    expect(next.git?.user).toEqual(current.git?.user);
  });
});
