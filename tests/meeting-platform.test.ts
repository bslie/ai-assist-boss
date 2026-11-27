import { describe, expect, it } from "vitest";
import { detectPlatform, extractMeetingUrl, MeetingUrlSchema } from "@/core/meetings/platform";

describe("detectPlatform", () => {
  it.each([
    ["https://us02web.zoom.us/j/123?pwd=x", "ZOOM", true],
    ["https://meet.google.com/abc-defg-hij", "GOOGLE_MEET", true],
    ["https://teams.microsoft.com/l/meetup-join/xyz", "TEAMS", true],
    ["https://telemost.yandex.ru/j/123", "TELEMOST", false],
    ["https://dion.vc/event/abc", "DION", false],
    ["https://evil-zoom.us.example.com/j/1", "UNKNOWN", false],
    ["not a url", "UNKNOWN", false],
  ])("%s → %s", (url, platform, bot) => {
    const p = detectPlatform(url);
    expect(p.platform).toBe(platform);
    expect(p.botSupported).toBe(bot);
  });
});

describe("MeetingUrlSchema", () => {
  it("rejects http and credentials", () => {
    expect(MeetingUrlSchema.safeParse("http://zoom.us/j/1").success).toBe(false);
    expect(MeetingUrlSchema.safeParse("https://user:pw@zoom.us/j/1").success).toBe(false);
    expect(MeetingUrlSchema.safeParse("https://zoom.us/j/1").success).toBe(true);
  });
});

describe("extractMeetingUrl", () => {
  it("finds the first known meeting link and trims punctuation", () => {
    expect(extractMeetingUrl("Ссылка: https://example.com/x и https://zoom.us/j/99?pwd=a.")).toBe("https://zoom.us/j/99?pwd=a");
  });
  it("returns null without a known platform", () => {
    expect(extractMeetingUrl("https://example.com/x")).toBeNull();
  });
});
