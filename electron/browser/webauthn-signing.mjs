const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9.-]+$/;

export function hasRealMacSigningIdentity(signingIdentity) {
  const normalizedIdentity = signingIdentity?.trim();
  return Boolean(normalizedIdentity && normalizedIdentity !== "-");
}

export function resolveBrowserWebAuthnKeychainAccessGroup({ bundleId, signingIdentity, teamId }) {
  if (!hasRealMacSigningIdentity(signingIdentity)) return undefined;
  const normalizedTeamId = teamId?.trim();
  if (!normalizedTeamId) return undefined;
  if (!BUNDLE_ID_PATTERN.test(bundleId)) {
    throw new Error("ARDOR_BUNDLE_ID is invalid");
  }
  if (!APPLE_TEAM_ID_PATTERN.test(normalizedTeamId)) {
    throw new Error("APPLE_TEAM_ID must be a 10-character Apple Team ID");
  }
  return `${normalizedTeamId}.${bundleId}.webauthn`;
}

export function renderBrowserWebAuthnEntitlements(keychainAccessGroup) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.device.bluetooth</key>
    <true/>
    <key>com.apple.security.device.camera</key>
    <true/>
    <key>com.apple.security.device.print</key>
    <true/>
    <key>com.apple.security.device.usb</key>
    <true/>
    <key>com.apple.security.personal-information.location</key>
    <true/>
    <key>keychain-access-groups</key>
    <array>
      <string>${keychainAccessGroup}</string>
    </array>
  </dict>
</plist>
`;
}
