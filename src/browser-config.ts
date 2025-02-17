type TemplateVariables = { [key: string]: string }

class BrowserConfig {
  constructor(
    public name: string,
    public platforms: { [platform: string]: PlatformConfig },
  ) {}

  private replaceTemplate(template: string, vars: TemplateVariables): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      if (!(key in vars)) throw new Error(`Missing variable: ${key}`)
      return vars[key]
    })
  }

  getDownloadUrl(platform: string, version: string, arch: string): string {
    const cfg = this.platforms[platform]
    if (!cfg || !cfg.arch.includes(arch))
      throw new Error(`Unsupported platform or arch for ${this.name}`)
    return this.replaceTemplate(cfg.downloadUrlTemplate, { version, arch })
  }

  getInstallPath(platform: string, basePath: string, version?: string): string {
    const cfg = this.platforms[platform]
    if (!cfg) throw new Error(`Unsupported platform for ${this.name}`)
    return this.replaceTemplate(cfg.installPathTemplate, {
      basePath,
      version: version || '',
    })
  }

  getExecutable(platform: string, installPath: string): string {
    const cfg = this.platforms[platform]
    if (!cfg) throw new Error(`Unsupported platform for ${this.name}`)
    return this.replaceTemplate(cfg.executableTemplate, { installPath })
  }
}

type PlatformConfig = {
  arch: string[]
  downloadUrlTemplate: string
  installPathTemplate: string
  executableTemplate: string
}

export const BROWSERS: { [key: string]: BrowserConfig } = {
  chrome: new BrowserConfig('Google Chrome', {
    windows: {
      arch: ['x64', 'arm64'],
      downloadUrlTemplate:
        'https://dl.google.com/chrome/install/{{version}}/chrome_installer.exe',
      installPathTemplate: '{{basePath}}\\Google\\Chrome\\Application',
      executableTemplate: '{{installPath}}\\chrome.exe',
    },
    mac: {
      arch: ['x64', 'arm64'],
      downloadUrlTemplate:
        'https://dl.google.com/chrome/mac/stable/GGRO/googlechrome-{{version}}.dmg',
      installPathTemplate: '{{basePath}}/Google Chrome.app/Contents/MacOS',
      executableTemplate: '{{installPath}}/Google Chrome',
    },
    linux: {
      arch: ['x64', 'arm64'],
      downloadUrlTemplate:
        'https://dl.google.com/linux/direct/google-chrome-stable_{{version}}_{{arch}}.deb',
      installPathTemplate: '{{basePath}}/bin',
      executableTemplate: '{{installPath}}/google-chrome',
    },
  }),
  chromium: new BrowserConfig('Chromium', {
    windows: {
      arch: ['x64', 'arm64'],
      downloadUrlTemplate:
        'https://download-chromium.appspot.com/dl/Win?type=snapshots',
      installPathTemplate: '{{basePath}}\\Chromium',
      executableTemplate: '{{installPath}}\\chrome.exe',
    },
    mac: {
      arch: ['x64', 'arm64'],
      downloadUrlTemplate:
        'https://download-chromium.appspot.com/dl/Mac?type=snapshots',
      installPathTemplate: '{{basePath}}/Chromium.app/Contents/MacOS',
      executableTemplate: '{{installPath}}/Chromium',
    },
    linux: {
      arch: ['x64', 'arm64'],
      downloadUrlTemplate:
        'https://download-chromium.appspot.com/dl/Linux?type=snapshots',
      installPathTemplate: '{{basePath}}/bin',
      executableTemplate: '{{installPath}}/chromium',
    },
  }),
  edge: new BrowserConfig('Microsoft Edge', {
    windows: {
      arch: ['x64', 'arm64'],
      downloadUrlTemplate:
        'https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/{{version}}/MicrosoftEdgeSetup.exe',
      installPathTemplate: '{{basePath}}\\Microsoft\\Edge\\Application',
      executableTemplate: '{{installPath}}\\msedge.exe',
    },
    mac: {
      arch: ['x64', 'arm64'],
      downloadUrlTemplate:
        'https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/{{version}}/MicrosoftEdge-{{version}}.pkg',
      installPathTemplate: '{{basePath}}/Microsoft Edge.app/Contents/MacOS',
      executableTemplate: '{{installPath}}/Microsoft Edge',
    },
    linux: {
      arch: ['x64', 'arm64'],
      downloadUrlTemplate:
        'https://packages.microsoft.com/repos/edge/pool/main/m/microsoft-edge-stable_{{version}}_{{arch}}.deb',
      installPathTemplate: '{{basePath}}/bin',
      executableTemplate: '{{installPath}}/microsoft-edge',
    },
  }),
  brave: new BrowserConfig('Brave', {
    windows: {
      arch: ['x64', 'arm64'],
      downloadUrlTemplate:
        'https://laptop-updates.brave.com/{{version}}/BraveBrowserSetup.exe',
      installPathTemplate:
        '{{basePath}}\\BraveSoftware\\Brave-Browser\\Application',
      executableTemplate: '{{installPath}}\\brave.exe',
    },
    mac: {
      arch: ['x64', 'arm64'],
      downloadUrlTemplate:
        'https://laptop-updates.brave.com/{{version}}/BraveBrowser.dmg',
      installPathTemplate: '{{basePath}}/Brave Browser.app/Contents/MacOS',
      executableTemplate: '{{installPath}}/Brave Browser',
    },
    linux: {
      arch: ['x64', 'arm64'],
      downloadUrlTemplate:
        'https://laptop-updates.brave.com/{{version}}/brave-browser_{{version}}_{{arch}}.deb',
      installPathTemplate: '{{basePath}}/bin',
      executableTemplate: '{{installPath}}/brave-browser',
    },
  }),
  arc: new BrowserConfig('Arc Browser', {
    mac: {
      arch: ['x64', 'arm64'],
      downloadUrlTemplate: 'https://arc.net/download/{{version}}',
      installPathTemplate: '{{basePath}}/Arc.app/Contents/MacOS',
      executableTemplate: '{{installPath}}/Arc',
    },
  }),
}

// Usage Example:
const browser = BROWSERS['chrome']
const downloadUrl = browser.getDownloadUrl('mac', '120.0.6099.109', 'arm64')
const installPath = browser.getInstallPath('mac', '/Applications')
const executable = browser.getExecutable('mac', installPath)

console.log({ downloadUrl, installPath, executable })
