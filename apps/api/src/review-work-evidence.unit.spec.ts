import { approvedWorkMatches, reviewLink, submittedEvidence, workEvidence } from "./review-work-evidence.js";

describe("submitted review evidence", () => {
  it.each(["", "http://files.sensestudios.com/a", "javascript:alert(1)", "file:///private/file.pdf", "https://localhost/a", "https://127.0.0.1/a", "https://[::1]/a", "https://0x7f000001/a", "https://a.internal/a", "https://user:password@files.sensestudios.com/a", "https://files.sensestudios.com:8443/a", "https://files.sensestudios.com/a\n"])('rejects unsafe review reference %s', value => {
    expect(() => reviewLink(value)).toThrow();
  });
  it("preserves and binds the exact public HTTPS URL without fetching content", () => {
    const evidence = workEvidence({ kind: "LINK", fileId: null, blobId: null, sha256: null, url: "https://files.sensestudios.com/design?version=2#page=3" });
    expect(evidence.url).toBe("https://files.sensestudios.com/design?version=2#page=3");
    expect(submittedEvidence({ workEvidence: evidence })).toEqual(evidence);
    expect(() => submittedEvidence({ workEvidence: { ...evidence, url: "https://files.sensestudios.com/different" } })).toThrow();
    expect(() => workEvidence({ ...evidence, fileId: "foreign-file" })).toThrow();
  });
  it("keeps historical task-only snapshots readable but rejects malformed new evidence", () => {
    expect(submittedEvidence({ title: "Historical task" })).toBeNull();
    expect(() => submittedEvidence({ workEvidence: { digest: "a".repeat(64) } })).toThrow();
    expect(() => workEvidence({ kind: "FILE", fileId: "file", blobId: "blob", sha256: "bad", url: null })).toThrow();
  });
  it("requires unchanged work scope while permitting ordinary planning changes", () => {
    const task = { title: "Design", description: "First floor", primaryOwnerEmployeeId: "owner", tags: ["design"], checklist: [], planItemId: null };
    const snapshot = { ...task, ownerEmployeeId: "owner", priority: "LOW", targetDate: "2026-12-31" };
    expect(approvedWorkMatches(task, snapshot)).toBe(true);
    expect(approvedWorkMatches({ ...task, title: "Different work" }, snapshot)).toBe(false);
    expect(approvedWorkMatches({ ...task, primaryOwnerEmployeeId: "other" }, snapshot)).toBe(false);
  });
});
