# Local security

The server binds to loopback and checks Host and Origin. It is a single-user app;
do not expose it with a public tunnel. Vault writes are off by default; notebook
revisions live separately. Back up both the original vault and local data.

AI is optional and uses only a provider you explicitly connect. Keys stay in memory.
Sharing excerpts requires consent. Source text and model claims are untrusted evidence.
Never commit vaults, databases, connection credentials or tokens.
