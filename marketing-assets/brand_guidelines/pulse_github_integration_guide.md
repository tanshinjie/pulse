# GitHub Repository Banner Integration Guide

## 📸 **Banner Setup Instructions**

### 1. **Upload Banner to Repository**
```bash
# Create assets directory in your repository
mkdir assets

# Copy the banner file
cp pulse_github_banner.png assets/

# Commit to repository
git add assets/pulse_github_banner.png
git commit -m "Add repository banner"
git push origin main
```

### 2. **Update README.md**
Add this line at the top of your README.md file (after the title):

```markdown
# Pulse

![Pulse Banner](https://raw.githubusercontent.com/yourusername/pulse/main/assets/pulse_github_banner.png)

A terminal-based productivity tracking application...
```

**Replace `yourusername` with your actual GitHub username!**

### 3. **Alternative Hosting Options**

If you prefer not to store the banner in your repository:

#### Option A: GitHub Releases
1. Create a release in your repository
2. Upload `pulse_github_banner.png` as a release asset
3. Use the direct download URL in your README

#### Option B: External Hosting
1. Upload to image hosting service (imgur, etc.)
2. Use the direct image URL in your README

#### Option C: GitHub Pages
1. Enable GitHub Pages for your repository
2. Create a `docs/assets/` directory
3. Upload banner and reference via GitHub Pages URL

### 4. **Banner Specifications**

- **Dimensions:** 1200x400 pixels
- **Format:** PNG with transparency support
- **File Size:** ~1.6MB (optimized for web)
- **Design:** Professional, GitHub-friendly aesthetic
- **Content:** Logo, tagline, key features, terminal preview

### 5. **Markdown Syntax Options**

#### Basic Image
```markdown
![Pulse Banner](URL_TO_BANNER)
```

#### Linked Image (clickable)
```markdown
[![Pulse Banner](URL_TO_BANNER)](https://github.com/yourusername/pulse)
```

#### With Alt Text and Title
```markdown
![Pulse - Mindful productivity tracking](URL_TO_BANNER "Pulse Productivity App")
```

#### HTML for More Control
```html
<p align="center">
  <img src="URL_TO_BANNER" alt="Pulse Banner" width="100%">
</p>
```

### 6. **Best Practices**

✅ **Do:**
- Use raw GitHub URLs for reliability
- Test the banner display on different screen sizes
- Ensure the banner loads quickly
- Keep the file size reasonable (<2MB)
- Use descriptive alt text for accessibility

❌ **Don't:**
- Use external hosting that might go down
- Make the banner too large (affects page load)
- Forget to update the username in the URL
- Use copyrighted images or fonts

### 7. **Testing Your Banner**

1. **Preview in GitHub:** Create a test branch and preview the README
2. **Check Mobile:** Ensure banner looks good on mobile devices
3. **Verify Loading:** Test that the image loads consistently
4. **Accessibility:** Confirm alt text is descriptive

### 8. **Troubleshooting**

**Banner not showing?**
- Check the URL is correct and accessible
- Verify the file path in your repository
- Ensure the image file was committed and pushed
- Try opening the direct image URL in a browser

**Banner too large/small?**
- GitHub automatically scales images in README files
- You can use HTML `<img>` tag with width/height attributes for more control

**Want to update the banner?**
- Simply replace the file in your repository
- GitHub will automatically update the display
- No need to change the README markdown

### 9. **Example Repository Structure**
```
pulse/
├── assets/
│   ├── pulse_github_banner.png
│   └── other_images/
├── src/
├── README.md
└── package.json
```

This banner will give your Pulse repository a professional, polished appearance that immediately communicates what the app does and its key benefits to visitors!

