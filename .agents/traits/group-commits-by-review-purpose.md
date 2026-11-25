---
name: group-commits-by-review-purpose
subject: Commit boundaries for a series of related edits
requirement: Group edits by the distinct change a reviewer needs to understand,
  not by file or verification checkpoint. Combine repeated applications of the
  same change when they can be reviewed and reverted together; keep
  independently meaningful changes separate.
purpose: Make the history easy to review without turning every work session or
  test run into a separate commit.
---
