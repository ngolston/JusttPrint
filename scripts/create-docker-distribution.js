#!/usr/bin/env node
// Cross-platform script to create Docker distribution package for JusttPrint

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = packageJson.version;

const distDir = 'dist';
const dockerDistDir = path.join(distDir, `justtprint-docker-${version}`);
const dockerDistZip = path.join(distDir, `justtprint-docker-${version}.zip`);

console.log(`Creating Docker distribution for JusttPrint ${version}...`);

// Create distribution directory
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}
if (fs.existsSync(dockerDistDir)) {
  fs.rmSync(dockerDistDir, { recursive: true, force: true });
}
fs.mkdirSync(dockerDistDir, { recursive: true });

// Everything the Docker build needs: all files tracked by git except the ones the image
// does not use (same intent as .dockerignore). No hand-maintained list to fall out of date.
const EXCLUDED_PREFIXES = ['tests/', '.github/', '.claude/', 'scripts/', 'demos/'];
const EXCLUDED_FILES = new Set(['CLAUDE.md', 'TODO.md', 'docker-compose.local.yml', '.gitignore', '.gitattributes']);
const filesToCopy = execSync('git ls-files -z', { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)))
  .filter((file) => !EXCLUDED_FILES.has(file) && !file.endsWith('.test.js'))
  .filter((file) => fs.existsSync(file));

console.log(`Copying ${filesToCopy.length} files...`);
for (const file of filesToCopy) {
  const target = path.join(dockerDistDir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
}
for (const required of ['Dockerfile', 'docker-entrypoint.sh', '.npmrc', 'package.json', 'package-lock.json', 'src/server/index.js', 'src/server/app.js']) {
  if (!fs.existsSync(path.join(dockerDistDir, required))) {
    console.error(`Missing required file in the distribution: ${required}`);
    process.exit(1);
  }
}

// Create README
const readmeContent = `# JusttPrint Docker Distribution

This package contains everything needed to run JusttPrint in server mode using Docker.

## Quick Start

1. **Extract this archive:**
   \`\`\`bash
   unzip justtprint-docker-*.zip
   cd justtprint-docker-*
   \`\`\`

2. **Add your models and a password:**
   Put your models in the \`models\` folder (or change the \`./models\` mount in \`docker-compose.yml\`),
   and set \`JUSTTPRINT_PASSWORD\` in \`docker-compose.yml\`.

3. **Build and run with Docker Compose:**
   \`\`\`bash
   docker compose up -d --build
   \`\`\`

4. **Access the server:**
   Open your browser to: http://localhost:5000 (or https:// if you enable TLS)

## HTTPS in Docker (optional)

Use **Settings → HTTPS / SSL** in the web UI to point at custom PEM files, generate a self-signed cert, or request Let's Encrypt. Issued/generated certs are stored in the data volume (\`./data\`).

Let's Encrypt HTTP-01 needs the hostname reachable on **port 80** — publish \`80:80\` in compose. The app still serves on port 5000 (\`https://\` / \`wss://\`).

Environment variables \`JUSTTPRINT_TLS_CERT\` and \`JUSTTPRINT_TLS_KEY\` still override the UI (mount PEMs and point the vars at them). If you terminate TLS on Traefik/Caddy/nginx instead, leave TLS unset and configure **WebSocket upgrade** on the proxy.

## Alternative: Build and Run Manually

\`\`\`bash
# Build the image
docker build -t justtprint:latest .

# Run the container
docker run -d \\
  --name justtprint-server \\
  -p 5000:5000 \\
  -v justtprint-data:/root/.config/justtprint \\
  --restart unless-stopped \\
  justtprint:latest
\`\`\`

## Network Shares

To access network shares, mount them into the container. See the main README.md for detailed instructions.

## Documentation

For complete documentation, see:
- Main README.md (included in full distribution)
- Docker section in application Help > Server Mode Info

## Support

For issues or questions, please refer to the main project repository.
`;

fs.writeFileSync(path.join(dockerDistDir, 'README.md'), readmeContent);

// Create zip archive
console.log('Creating zip archive...');
try {
  // Zip the folder itself, so unzipping gives justtprint-docker-<version>/.
  if (fs.existsSync(dockerDistZip)) fs.unlinkSync(dockerDistZip);
  execSync(`zip -qr ${path.basename(dockerDistZip)} ${path.basename(dockerDistDir)}`, { cwd: distDir, stdio: 'inherit' });
} catch (err) {
  console.error('Error creating zip archive:', err.message);
  console.log('Files are ready in:', dockerDistDir);
  console.log('Please create the zip archive manually.');
  process.exit(1);
}

const stats = fs.statSync(dockerDistZip);
const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

console.log('');
console.log('✓ Docker distribution created successfully!');
console.log(`  Location: ${dockerDistZip}`);
console.log(`  Size: ${sizeMB} MB`);
console.log('');
console.log('To distribute:');
console.log(`  1. Upload ${path.basename(dockerDistZip)} to your release page`);
console.log('  2. Users can extract and run: docker-compose up -d');
