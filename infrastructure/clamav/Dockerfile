FROM clamav/clamav@sha256:75fb5fd95fcbe1d7e6d240c369c1572b686ee2c95949d1042b5148de8eddebb4

# The default clamd stream limit is too small for the 100 MiB production gate.
# Keep this aligned with the staged AGENT_ASSET_MAX_BYTES policy.
RUN sed -i \
      -e 's/^#\?StreamMaxLength .*/StreamMaxLength 1G/' \
      -e 's/^#\?MaxScanSize .*/MaxScanSize 1G/' \
      -e 's/^#\?MaxFileSize .*/MaxFileSize 1G/' \
      /etc/clamav/clamd.conf \
  && grep -qx 'StreamMaxLength 1G' /etc/clamav/clamd.conf \
  && grep -qx 'MaxScanSize 1G' /etc/clamav/clamd.conf \
  && grep -qx 'MaxFileSize 1G' /etc/clamav/clamd.conf
