# GitHub Actions Setup Instructions

This repository includes automated CI/CD workflows that will:
- ✅ Run tests on multiple Node.js versions and operating systems
- ✅ Perform security audits
- ✅ Automatically publish to npm when version changes
- ✅ Create GitHub releases
- ✅ Verify package quality

## 🔧 Required Setup

### 1. **npm Token Setup**

To enable automatic npm publishing, you need to add your npm token as a GitHub secret:

#### **Step 1: Generate npm Token**
```bash
# Login to npm (if not already)
npm login

# Generate an automation token
npm token create --type=automation
```

#### **Step 2: Add to GitHub Secrets**
1. Go to your repository: https://github.com/tanshinjie/pulse
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `NPM_TOKEN`
5. Value: Your npm token (starts with `npm_`)
6. Click **Add secret**

### 2. **Workflow Permissions**

Ensure GitHub Actions has the necessary permissions:

1. Go to **Settings** → **Actions** → **General**
2. Under **Workflow permissions**, select:
   - ✅ **Read and write permissions**
   - ✅ **Allow GitHub Actions to create and approve pull requests**

## 🚀 How It Works

### **Automatic Publishing Workflow** (`.github/workflows/publish.yml`)

**Triggers:**
- Push to `main` branch
- Pull requests to `main` branch

**Process:**
1. **Test Phase**: Runs tests on Node.js 16, 18, and 20
2. **Version Check**: Compares current version with published version
3. **Publish**: Only publishes if version number changed
4. **Release**: Creates GitHub release with changelog
5. **Notification**: Reports success/failure

### **Continuous Integration Workflow** (`.github/workflows/ci.yml`)

**Triggers:**
- Push to `main` or `develop` branches
- Pull requests

**Process:**
1. **Lint**: Validates package.json and required files
2. **Cross-platform Testing**: Tests on Ubuntu, macOS, and Windows
3. **Security Audit**: Checks for vulnerabilities
4. **Package Quality**: Verifies size and contents

## 📦 Publishing Process

### **Manual Version Bump**
```bash
# Patch version (1.0.0 → 1.0.1)
npm version patch

# Minor version (1.0.0 → 1.1.0)
npm version minor

# Major version (1.0.0 → 2.0.0)
npm version major

# Push the version tag
git push origin main --tags
```

### **Automatic Publishing**
1. Update version in `package.json`
2. Commit and push to `main` branch
3. GitHub Actions automatically:
   - Runs all tests
   - Publishes to npm (if version changed)
   - Creates GitHub release
   - Notifies of success/failure

## 🔍 Monitoring

### **Check Workflow Status**
- Go to **Actions** tab in your repository
- View real-time logs and results
- Get email notifications on failures

### **npm Package Status**
- View at: https://www.npmjs.com/package/pulse-track-cli
- Check download stats and versions

## 🛠️ Troubleshooting

### **Common Issues**

#### **npm Token Invalid**
```
Error: 401 Unauthorized
```
**Solution**: Regenerate npm token and update GitHub secret

#### **Version Not Changed**
```
Version unchanged: 1.0.0
```
**Solution**: Update version in `package.json` before pushing

#### **Tests Failing**
```
npm test failed
```
**Solution**: Fix tests locally before pushing

#### **Package Too Large**
```
Package too large: 6MB (max 5MB)
```
**Solution**: Add large files to `.npmignore`

### **Manual Override**

If you need to publish manually:
```bash
# Skip CI and publish directly
npm publish --access public

# Or force publish (use carefully)
npm publish --access public --force
```

## 📋 Workflow Files

- **`.github/workflows/publish.yml`**: Main publishing workflow
- **`.github/workflows/ci.yml`**: Comprehensive testing workflow
- **`.npmignore`**: Excludes marketing assets from npm package
- **`.gitignore`**: Standard Node.js gitignore

## 🎯 Benefits

✅ **Automated Quality Assurance**: Every push is tested  
✅ **Cross-platform Compatibility**: Tests on multiple OS/Node versions  
✅ **Security Monitoring**: Automatic vulnerability scanning  
✅ **Zero-downtime Publishing**: Automatic npm releases  
✅ **Version Management**: Automatic GitHub releases  
✅ **Package Optimization**: Size and content verification  

Your Pulse app is now ready for professional, automated deployment! 🚀

