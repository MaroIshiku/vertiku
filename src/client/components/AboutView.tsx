export function AboutView({ version }: { version: string }) {
  return <section className="workspace-card psu-card about-card">
    <img className="app-icon" src="/vertiku-icon.png" alt="" />
    <p className="eyebrow">ABOUT</p>
    <h1>Vertiku</h1>
    <p>A private, self-hosted conversion workspace. Vertiku creates chaptered M4B audiobooks from uploads or read-only folders below <code>/input</code>.</p>
    <dl>
      <div><dt>Version</dt><dd>{version || 'Unknown'}</dd></div>
      <div><dt>Conversion engine</dt><dd>FFmpeg (runtime detected)</dd></div>
      <div><dt>Privacy</dt><dd>No remote URL imports or outbound media services</dd></div>
    </dl>
    <p className="fine-print">Vertiku does not bypass DRM, includes no yt-dlp integration, and has no dependency on Pulliku.</p>
  </section>;
}
