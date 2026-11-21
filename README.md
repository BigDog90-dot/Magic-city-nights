# Magic City Nights

Plan a Birmingham date or night out. Pick a spot for each stop, or let it roll a surprise plan.

- `index.html` is the whole app.
- `spots.json` is the starter list of places. A visitor who hasn't changed anything sees this list.

## How saving works on the website

There's no server. When someone adds or deletes spots or saves a night, it's kept in their own browser on that device. Other people don't see it. To change the starter list everyone sees, edit `spots.json` and push.

## Put it online with GitHub Pages

1. Get these files onto the `main` branch (merge the pull request, or upload them there).
2. On a free GitHub plan, Pages needs a public repo. Go to **Settings → General → Danger Zone → Change visibility → Public**.
3. Go to **Settings → Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**. Pick **main** and **/ (root)**, then click **Save**.
4. Wait a minute or two. The site will be at `https://<your-username>.github.io/Magic-city-nights/`.
