# Pear Paste

Launch Pear Paste from the service page after the Web Interface health check is
ready.

On first launch, create a vault or restore one from its recovery phrase. Keep
the recovery phrase offline; the service stores only the local wrapped vault
state in the StartOS volume mounted at `/data`.

Backups include the main service volume. Restarting the service keeps your vault
store and peer state intact.
