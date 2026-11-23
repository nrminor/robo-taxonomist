---
name: prefer-effect-owned-test-fixtures
subject: Design of tests for Effect-managed services
requirement: Design the test around dependency injection. Identify the service
  that the test verifies, keep its real implementation, and provide a test layer
  for its dependencies. Do not keep the same mock design and only replace its
  functions with Effect equivalents. Use fibers, scopes, and Effect
  synchronization for work the test owns. Keep Promise and AbortSignal at
  external boundaries that require them or that the test verifies.
purpose: Make the dependency under test explicit, preserve the behavior being
  verified, and give test work a clear owner.
---
To verify Fetch cancellation, keep FetchHttpClient.layer and inject a fake FetchHttpClient.Fetch beneath it. The fake can expose a Queue of requests and a Deferred reply for each request. Observe the adapter’s AbortSignal; do not create a second cancellation path. For UI-only behavior, inject HttpClient directly if the Fetch adapter is not under test.