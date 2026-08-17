FROM clamav/clamav@sha256:7173cd3d57a839c6fee673b07246301e0d1f68f5a14a5ca063f502323bf1cc61

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
