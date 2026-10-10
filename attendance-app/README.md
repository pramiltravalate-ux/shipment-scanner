# Employee Attendance & Salary App (Google Apps Script)

A mobile-friendly web app that runs on a Google Sheet. It lets employees:

- **Check in and check out** only when they are within **30 m of the office**, checked by GPS.
- **Take a selfie at check-in** with the live front camera. Photos are saved to a Google Drive folder.
- **See their month**: pick any month and see a colour-coded calendar (Absent, Half Day, OT, Late). The month view also shows late and early-leaving minutes, net OT, advance recovery and the salary breakdown with PF and one **Total Salary** figure. The In Bank / In Cash split is shown only to admins who have permission to see it.
- **Download a payslip** (PDF or print) for any month.
- **Send requests:** leave (paid or unpaid) and attendance corrections (forgot to check in or out).
- **Change their own PIN.**
- **Use the app only to check in and to check out.** Nothing runs in the background and there is no tracking during the day. Location is checked only at the moment of check-in and check-out.
- **Keep the phone clock on automatic.** If the phone's time or time zone is wrong, the app blocks check-in/out. Recorded times always come from Google's server, not the phone.

Admins (with the permissions a super admin gives them) get these screens:

| Screen | What it does |
|---|---|
| Today | **Missed check-outs on top**, live attendance with selfies, and **⚠ flags** on suspicious check-ins |
| Monthly Summary | Month totals for all employees: **total payment (In Bank / In Cash / non-PF)**, presents, absents, half days, late, OT, **PF employee + employer + total deposit**, and a per-employee table |
| Payroll | Every employee's salary and PF (bank/cash split with permission); **lock the month**; **download the payroll as an Excel file** (.xlsx, with a totals row) |
| Requests | Approve or reject leave, corrections and OT |
| Entries | Back-dated entries for one day, or bulk-fill many days |
| Employees | Add employees, change salary and details, deactivate, reset PINs |
| Advances | Give an advance and recover it in monthly instalments |
| PF Setup | Turn PF on or off per employee and set the amounts |
| Admins *(super admin only)* | Make admins and choose what each one may do |
| Activity *(super admin only)* | Everything admins changed |

No Google account is needed for employees. They log in with **Employee ID + PIN**.

---

## 1. Install (about 10 minutes)

1. Create a new **Google Sheet**, for example "Attendance".
2. Open **File → Settings** and set the **Time zone** to your local zone, for example `(GMT+05:30) India Standard Time`.
3. Open **Extensions → Apps Script**.
4. Copy the code into the editor:
   - Replace everything in `Code.gs` with the contents of [`Code.gs`](Code.gs).
   - Click **+ → HTML**, name the file **`Index`** (exactly, without `.html`) and paste the contents of [`Index.html`](Index.html).
5. Open **Project Settings ⚙** and set the **Time zone** to the same zone as the Sheet.
6. Back in the editor, select the function **`setup`** and click **Run**. Allow the permissions when asked: Sheets, Drive and external pages.
   This creates all the tabs (Settings, Employees, Attendance, Holidays, Requests, Advances, Payroll Locks, Payroll Snapshots, Admin Permissions, Audit Log) and a Drive folder for selfies.
7. Fill in the Sheet (see section 2).
8. Deploy the app:
   - Click **Deploy → New deployment → ⚙ → Web app**.
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
   - Click **Deploy** and copy the **Web app URL**.
9. Send the URL to employees. On their phone, they open it in **Chrome** (Android) or **Safari** (iPhone) and tap **⋮ / Share → Add to Home Screen** to use it like an app.

> **Updating from an earlier version:** paste both files, run `setup` again (it only adds what is missing and never deletes data), then go to **Deploy → Manage deployments → ✏ Edit → Version: New version → Deploy**. This keeps the same URL.

### Recommended: open the app from GitHub Pages (works with several Google accounts)
Chrome shows *"Google Drive – Sorry, unable to open the file at present"* for `script.google.com/macros/...` links when the phone is signed into more than one Google account. This is a Google bug. To avoid it, the same page is also published on GitHub Pages and talks to your Apps Script in the background, without any Google login:

1. Merge this branch into `main`. GitHub Pages publishes `attendance/index.html`.
2. Copy your **deployment ID** from **Deploy → Manage deployments**. It's the long `AKfycb…` text above the Web app URL.
3. Share this link with everyone:
   ```
   https://travalateapp.github.io/shipment-scanner/attendance/?id=YOUR_DEPLOYMENT_ID
   ```
   The phone remembers the ID after the first visit, so **Add to Home Screen** works too.

GPS, the camera and PDF downloads also work better this way, because the page is not inside Google's frame.
**After each code update:** paste `Code.gs` into Apps Script and redeploy (**Edit → New version**, which keeps the same ID). Then copy `attendance-app/Index.html` to `attendance/index.html` in GitHub (the two files are identical).

---

## 2. Fill the Sheet

### Settings tab

| Setting | Default | Meaning |
|---|---|---|
| Company Name | My Company | Shown in the app and on payslips |
| **Office Latitude / Longitude** | *(empty)* | In Google Maps, **right-click your office → click the coordinates** to copy them |
| Allowed Radius (m) | **30** | How close to the office an employee must be |
| Max GPS Accuracy (m) | 50 | GPS readings less accurate than this are rejected |
| Flag GPS Accuracy Above (m) | 35 | Less accurate check-ins are flagged for admins |
| Check Location On Check-Out | Yes | Also require being at the office when checking out |
| Selfie Required | Yes | A selfie is needed at check-in |
| Live Camera Only | No | `Yes` = no gallery photos at all. **Test on your phones first**, then switch on |
| Shift Start | 09:30 | Used for late marking. Shift end = start + Standard Hours |
| Late Grace (min) | 10 | A check-in after 09:40 counts as **Late** |
| Standard Hours | **9** | Hours beyond this are OT |
| Full Day / Half Day Min Hours | 8 / 4 | 8 h or more = full day, 4–8 h = **Half Day**, under 4 h = **Absent** |
| No Check-Out Counts As | HALF_DAY | How a day that was auto-checked-out at midnight counts until an admin fixes it |
| Allow Overnight Shift | No | `Yes` = a check-out after midnight closes the previous day |
| Max Shift Hours | 16 | Longest shift allowed with overnight on |
| Salary Days Basis | **30** | Per day = salary ÷ 30, per hour = per day ÷ 9, per minute = per hour ÷ 60 |
| OT Multiplier | **1.5** | OT pay = net OT minutes × per-minute rate × 1.5. **Set `1` for the normal rate** |
| OT Block (min) | 0 | `0` counts every minute. `30` counts each day's OT only in full 30-minute blocks |
| Max OT Per Day (min) | 0 | Cap on OT per day (`0` = no cap) |
| OT Needs Approval | No | `Yes` = OT counts only after an admin approves it |
| Late Minutes Reduce OT | Yes | Net OT = OT − late minutes |
| Early Leaving Reduces OT | Yes | Net OT = OT − minutes left before shift end |
| Weekly Off | Sunday | For example `Sunday` or `Saturday,Sunday` |
| Off-Day Work Is OT | Yes | All hours worked on a weekly off or holiday count as OT |
| Lates Per Half-Day Cut | 0 | Optional extra penalty: every N late marks deduct half a day (`0` = off) |
| Phone Time Tolerance (min) | 3 | Check-in is blocked if the phone clock is off by more than this |
| Default PF Bank Salary % / Employee % / Employer % | 90 / 12 / 13 | Used when the PF boxes are blank |
| OT & Deductions Paid In | CASH | For PF employees, which part absorbs OT, leave and advance deductions |
| Round To Rupee | Yes | Salary amounts in whole rupees |
| Admin Back-Date Limit (days) | 45 | How far back admins can change entries (super admin: no limit) |
| Request Back-Date Limit (days) | 7 | How far back employees can request corrections or leave |

### Employees tab

| Emp ID | Name | PIN | Monthly Salary | Role | Active | Join Date | Phone | PF Active | PF Bank Salary | PF Employee | PF Employer |
|---|---|---|---|---|---|---|---|---|---|---|---|
| E001 | Owner Name | 4821 | 30000 | SUPER_ADMIN | Yes | 2026-01-01 | | No | | | |
| E002 | Ravi Kumar | 1111 | 15000 | EMPLOYEE | Yes | 2026-03-15 | | Yes | 13500 | 1721 | 1755 |

- You can add employees here or in the app (**Admin → Employees**).
- **PINs are encrypted (hashed) automatically.** A PIN typed into the sheet works once, and is replaced by a code like `sha256$…` after that employee's first login. To reset a PIN, use **Admin → Employees → Edit → Reset PIN**, or type a new plain PIN into the sheet.
- Role is `EMPLOYEE`, `ADMIN`, `SUPER_ADMIN` or `GUARD` (see section 4). A guard's salary can be left empty.
- When someone leaves, untick **Active**. Their history is kept.

### Holidays tab
Add one row per paid holiday: `2026-10-20 | Diwali`.

---

## 3. How salary is calculated

```
Per day    = Total Salary ÷ 30
Per hour   = Per day ÷ 9
Per minute = Per hour ÷ 60

Late minutes  = check-in − Shift Start         (only on days marked Late)
Early minutes = shift end − check-out          (on present days)
Net OT mins   = OT minutes − late minutes − early minutes   (never below 0)
OT pay        = Net OT mins × Per minute × OT Multiplier

Leaves     = Absent days × Per day
Half Days  = Half days × ½ × Per day
Gross      = Total Salary + OT pay − Leaves − Half Days
Net        = Gross − advance instalment (− PF Employee for PF employees)
```

**Current month:** the salary is shown only for the days that have passed: Monthly Salary × days passed ÷ days in the month. Today counts once the employee has checked in. PF and Basic Salary are counted for the same days. The amount grows every day, and once the month is over it is the full month's salary. The Monthly Summary and payslips work the same way.

**Employees with PF:**

| | Example: ₹15,000, full month |
|---|---|
| Total Salary | 15,000 |
| OT / Leaves / Half Days | per calculation |
| PF Employee | 1,721 (deducted) |
| PF Employer | 1,755 (company contribution, shown only) |
| **In Bank** = Basic Salary − PF Employee | 13,500 − 1,721 = **11,779** |
| **In Cash** = Salary − Basic Salary + OT − Leaves − Half Days − Advance | 15,000 − 13,500 = **1,500** |
| **Total Salary** = In Bank + In Cash | **13,279** |

Employees, and admins without the *View Bank / Cash Split* permission, see only **Total Salary**: in the app, on payslips and in the payroll export. "Basic Salary" is the *PF Bank Salary* column in the Employees tab.

If the deductions are more than the cash part, the rest comes out of the bank part. (With a ₹2,000 advance instalment: cash 0, bank 11,279.)

### Forgotten check-outs (automatic at midnight)
`setup` installs an hourly timer (Apps Script trigger) that **checks out automatically after midnight** anyone who checked in but never checked out. Such a day:
- counts as **No Check-Out Counts As** (Half Day by default), with no OT;
- shows a **red outline** in the calendar and a red warning at the top of the employee's home screen;
- stays **at the top of Admin → Today** under *Missed check-outs* until an admin clears it, in one of three ways:
  - enter the real check-out time (hours, OT and status are recalculated);
  - choose **Clear as is**;
  - approve the employee's correction request, or edit that day in **Entries**.

Employees cannot clear it themselves. They can only send a correction request. A month with uncleared missed check-outs **cannot be locked**.
With *Allow Overnight Shift* = Yes, a night shift is closed automatically only after *Max Shift Hours*.

> The first time `setup` runs, Google asks for permission to "run when you are not present". Allow it, because the midnight check-out needs it. To check, open **Apps Script → Triggers ⏰**: there should be one `autoCheckout` trigger, running every hour.

### Locking a month
At month end, check **Admin → Payroll** and tap **🔒 Lock month**. After that:
- The salaries become **final**. A copy is saved in *Payroll Snapshots*, so later changes to salary, PF or settings don't affect that month.
- Attendance entries, leave approvals and corrections for that month are blocked.
- Payslips no longer say "Provisional".
- Only a super admin can unlock a month.

### Advances
**Admin → Advances → Give an advance**: enter the amount, the deduction per month and the first month to deduct. Each month's salary recovers the instalment until the balance is zero.
- **Employees request advances in the app:** Requests → *Salary advance*, with the amount, a suggested monthly deduction and a reason. Admins with **Manage Advances** see it under Admin → Requests. They can change the amount or deduction and approve it either as a **new separate advance** or **added to an advance already running**. Admins can still enter an advance directly under Advances, e.g. one already given in cash.
- **Change or skip this month's deduction from anywhere:** besides the Advances tab, a **Change** button appears next to each advance in the **Monthly Summary** (💳 Advances this month) and on an employee's **salary card** in the admin calendar. Only admins with Manage Advances see these buttons; employees only see the result.
- **More money while an advance is running:** you have two choices.
  - **＋ Add more** on the advance adds the new amount to the same balance, can change the monthly deduction, and logs it as "➕ date +amount".
  - A new advance from **Give an advance** stays separate, with its own monthly deduction, and both are deducted each month. The form warns you when the employee already has an advance running.
- **Change a month:** for any one month, choose **No deduction** or **Deduct a different amount** (e.g. ₹1,000 or ₹5,000), with an optional note. Only that month changes, and the balance simply takes longer, or less time, to clear. Each change is listed on the advance with an **Undo**, and the employee sees it on their salary card. Locked months can't be changed.
- **Pause** skips months until you resume.
- **Close** stops recovery for good, for example if the rest was repaid in cash.
- **Change monthly** changes the instalment from now on. Locked months keep what was actually deducted.

---

## 4. Roles, permissions and requests

| Role | Can do |
|---|---|
| `EMPLOYEE` | Own attendance, month, payslip, requests and PIN |
| `ADMIN` | Only what the super admin allows. Admins can **never change another admin or a super admin**, even with *All employees*. Super admins are also hidden from them. Admins change their own data only with *Edit Own Entries*. Admins' own requests and missed check-outs go to a super admin |
| `SUPER_ADMIN` | Everything, plus the **Admins** and **Activity** screens, and unlocking months |
| `GUARD` | **Only** checks other employees in and out (Mark Attendance). A guard is not an employee: no attendance, salary, payslip or requests of their own, can't mark themselves, and isn't counted in Today, Payroll, Summary or the Excel export. Guards can change their own PIN |

Permissions the super admin can give each admin (**Super Admin → Admins**):

- View Today
- View Payroll
- Edit Attendance
- Approve Requests
- Edit PF
- Manage Employees
- Manage Advances
- Export Payroll (download the Excel file)
- Lock Payroll
- Mark Attendance for Others (no phone / forgot phone). Guards have this automatically and don't need an admin permission
- View Bank / Cash Split
- View Monthly Summary (the bank/cash totals on it also need *View Bank / Cash Split*)
- Edit Own Entries

Each admin also gets a scope: **All employees** or **Only selected**.

**Requests** (employee → admin):
- **Leave:** a date range, paid or unpaid. The admin can change paid/unpaid when approving. Approved leave appears in the calendar and is counted when the day arrives.
- **Correction:** the right check-in and/or check-out time for a day. Approving it updates that day.

**Back-dated entries** (**Admin → Entries**):
- **Fill many days** goes up to **yesterday** only, so it can never block a real check-in. Use **One day** for today.
- **Status:** "Auto" works things out from the times. *Present* and *Half Day* keep the late mark. *Leave* and *Absent* remove it.
- **Admin marks today as Leave or Absent:** if the employee then checks in, the check-in replaces that status.

Every change is written to the **Audit Log** tab.

### Employees without a smartphone, or who forgot their phone (Admin → Mark Attendance)
An admin or a **guard** can check employees in and out from their own phone:
- **This phone's GPS** must be at the office, the same radius check as normal.
- **A photo of the employee is compulsory at check-in.** The app opens the back camera (🔄 switches to the front one), shows the photo for a final check, and saves it like a selfie. Admins see it in Admin → Today. Check-out needs only the location, the same as an employee's own check-out. A photo is required even when *Selfie Required* = No.
- Every entry records who marked it by **real name**. The Mark Attendance list, Today, the calendar and Entries show "👤 Check-in marked by Pramil" for an admin, or "👤 Check-in marked by Guard (Ramesh)" for a guard. It is also written to the Audit Log. These entries are not counted as suspicious.
- **Setting up a guard:** Super Admin → **Employees → Add**, give them an ID and PIN, leave the salary empty and set **Role = Guard**. You can also type `GUARD` in the Role column of the sheet. After login the guard sees only the Mark Attendance screen, with all employees. They can't mark themselves, admins or super admins. Only super admins can see or change a guard.
- They can't mark admins, super admins or themselves. Only today's check-in and check-out can be marked here; for other days use Entries.

### Hindi / English (employees and guards)
Employees see an **English | हिंदी** switch at the top of the Attendance screen. Guards see it at the top of their Mark Attendance screen, and in Hindi that whole screen is in Hindi too.
- In Hindi, all of the employee's screens are in Hindi: Attendance, My Month, Requests, the PIN screen and the error messages (for example "too far from the office").
- Numbers, amounts, times and dates stay in English digits (₹4,355 · 09:30 · 10 अक्टूबर 2026).
- The phone remembers the choice. The login screen, the payslip and all admin and super-admin screens stay in English. Admins and super admins don't see the switch.

## 5. Things to know

- **30 m is tight.** Indoor GPS is often only accurate to 10–40 m. If genuine employees get "too far" errors, raise the radius to 50 m or raise *Max GPS Accuracy*. Test from different corners of the office first.
- **Fake GPS:** no web app can fully block fake-GPS apps. The app flags check-ins with weak GPS, or with the **exact same coordinates** as another day or another person. Fake-GPS apps typically produce identical coordinates, while real GPS always varies a little. Check flagged selfies in **Admin → Today**.
- **Live camera:** the selfie opens the front camera inside the app. If a phone or browser blocks the camera inside the app, it falls back to the phone's camera, unless *Live Camera Only* = Yes.
- **Location and camera permission:** employees must allow both for the site. If they denied it, they open browser settings → Site settings → Location / Camera → Allow.
- **Payslip download:** if the PDF download doesn't start on a phone, use **Print → Save as PDF**.
- **Five wrong PIN attempts** lock that Employee ID for 15 minutes.
- **Speed:** the Settings, Employees, Holidays, Admin Permissions and Payroll Locks tabs are kept in Google's cache, so most actions don't open them. Edits made by hand in those tabs reach the app straight away, because the cache is cleared on edit. Screens you have already opened show at once and then refresh.
- **Automatic retry:** if Google answers with an error page (for example a 404) or the network drops, the app retries up to 3 times. Retries never create duplicate entries.
- **The morning rush:** selfies are uploaded before the app waits its turn to write to the sheet, so many people can check in at the same minute.
