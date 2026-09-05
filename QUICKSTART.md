# Getting started

Three ways to run the simulator, easiest first. **You do not need to know how to
use a terminal for any of them.**

---

## Option 1 — Just open a link (easiest, nothing to install)

Once someone on your team has turned on hosting (see
[Setting up the link](#setting-up-the-link-one-time-30-seconds) at the bottom —
it takes about 30 seconds), the simulator lives at a web address:

**`https://shrimpsooup2.github.io/drivingSim/`**

Open it in Chrome, Edge, Firefox or Safari. That is the whole process. It works
on a school laptop, a Chromebook, or any computer with a browser — nothing gets
installed, and there is nothing to keep up to date.

This is the right option for **drivers**. Bookmark it.

---

## Option 2 — Run it on your own computer (works offline)

Useful if you want to drive without wifi, or you are editing the code.

### Step 1 — Download the files

1. Go to <https://github.com/shrimpsooup2/drivingSim>
2. Click the branch dropdown (it probably says `main`) and pick
   **`claude/ftc-driving-simulator-j65m6n`**
3. Click the green **Code** button → **Download ZIP**
4. Find the ZIP in your Downloads folder and **double-click it** to unzip

You now have a folder called something like `drivingSim-claude-ftc-driving-simulator-j65m6n`.

### Step 2 — Start it

**On a Mac:** double-click **`Start Simulator (Mac).command`**

**On Windows:** double-click **`Start Simulator (Windows).bat`**

A small black window will open with some text in it, and your browser will open
the simulator automatically.

> **Leave the black window open while you drive.** It is the thing serving the
> simulator to your browser. Closing it stops the simulator. When you are done,
> just close it.

### If your Mac refuses to open the file

macOS blocks files downloaded from the internet the first time. You will see
something like *"cannot be opened because it is from an unidentified developer."*

The fix takes one extra click:

1. **Right-click** (or Control-click) `Start Simulator (Mac).command`
2. Choose **Open** from the menu
3. Click **Open** again in the dialog that appears

You only have to do this once. After that, double-clicking works normally.

### If it says no web server tool is installed

Some computers do not have the necessary tool. You have two choices:

- **Use Option 1 instead** (the link). Genuinely easier, and identical.
- **Install Node once**: go to <https://nodejs.org>, download the big green
  **LTS** button, run the installer, accept the defaults. Then the double-click
  file works forever.

---

## Option 3 — For people who are comfortable in a terminal

```bash
git clone https://github.com/shrimpsooup2/drivingSim.git
cd drivingSim
git checkout claude/ftc-driving-simulator-j65m6n
npm start
```

No `npm install` — there are no dependencies. Also available:
`npm test` (113 tests) and `npm run check` (headless browser check + screenshots).

---

## Once it is open

### Plug in a controller

Connect an Xbox controller or a Logitech F310, then **press any button on it**.

> Browsers hide game controllers until you actually use one, so a controller
> that is plugged in but untouched will look disconnected. Pressing a button
> wakes it up.

**Logitech F310 owners:** there is a small switch on the back. It must be on
**X**, not **D**. On D the buttons and sticks are mapped differently and the
simulator will show a warning telling you so.

Look at the bottom-left of the screen: it says `CONTROLLER` when one is
connected, `KEYBOARD` otherwise.

### Or just use the keyboard

| Key | What it does |
| --- | --- |
| `W` `S` | Drive forward / back |
| `A` `D` | Strafe left / right |
| `Q` `E` | Turn left / right |
| `Shift` | Precision mode (slow) |
| `R` | Put the robot back at the start |
| `C` | Change camera |
| `?` | Show all the controls |

Keyboard is fine for learning the field. It is not much use for learning
throttle control, because a key is either fully on or fully off.

### Try this first

1. Drive to the far wall and back. Notice it is harder to judge distance than
   you expect — that is deliberate, and it is what a real match feels like from
   the driver station.
2. Slam the stick forward from a stop. Watch the arrows at the wheels turn red
   and the red crosses appear: you just spun the wheels, and you accelerated
   *slower* because of it.
3. Press `Tab` to open the settings, find **Acceleration ramp**, and lower it.
   Try the same launch again.

---

## Setting up the link (one time, 30 seconds)

Someone with admin access to the repository does this once, and then everyone
else gets Option 1 forever.

1. Go to <https://github.com/shrimpsooup2/drivingSim/settings/pages>
2. Under **Build and deployment**, set **Source** to **GitHub Actions**
3. Done

The next push publishes the site. You can also trigger it now from the
**Actions** tab → **Deploy to GitHub Pages** → **Run workflow**.

The address will be **`https://shrimpsooup2.github.io/drivingSim/`**. Share it
with the team.

> The published site is public — anyone with the link can open it. It is a
> driving simulator with no data in it, so that is usually fine, but it is worth
> knowing before you turn it on.

---

## Something not working?

**The page is blank or says WebGL2 is not available.**
Your browser or graphics driver is too old. Chrome, Edge, Firefox and Safari
have all supported WebGL2 for years, so updating the browser normally fixes it.

**The robot drives on its own / drifts without me touching anything.**
A worn controller stick. Open settings (`Tab`), find **Stick deadband**, and
raise it until the drift stops.

**Nothing happens when I move the controller.**
Press a button on it first. If it still does nothing, check the F310 switch is
on **X**, and look for a warning at the bottom of the screen.

**The black window closed straight away.**
Usually means no web server tool is installed — see above. Use the link
instead, or install Node.

**Double-clicking the Mac file opens it in TextEdit instead of running it.**
The ZIP lost the "this is a program" flag on the way to your computer. Either
use the link (Option 1), or open the **Terminal** app once and run:

```
chmod +x "/path/to/Start Simulator (Mac).command"
```

Tip: type `chmod +x ` (with the space), then drag the file from Finder into the
Terminal window — it fills in the path for you. Press Return. Double-clicking
will work from then on.

**Everything is slow / choppy.**
Open settings and lower **Physics substep rate** from 2000 to 1000. On a very
old laptop, also turn off **Telemetry graphs**.
