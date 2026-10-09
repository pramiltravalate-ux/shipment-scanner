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
| Payroll | Every employee's salary and PF (bank/cash split with permission); **lock the month**; export to the Sheet |
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
- Role is `EMPLOYEE`, `ADMIN` or `SUPER_ADMIN` (see section 4).
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
- **Pause** skips months until you resume.
- **Close** stops recovery for good, for example if the rest was repaid in cash.
- **Change monthly** changes the instalment from now on. Locked months keep what was actually deducted.

---

## 4. Roles, permissions and requests

| Role | Can do |
|---|---|
| `EMPLOYEE` | Own attendance, month, payslip, requests and PIN |
| `ADMIN` | Only what the super admin allows. Admins **never see or change super admins**, and never change their own data unless given *Edit Own Entries* |
| `SUPER_ADMIN` | Everything, plus the **Admins** and **Activity** screens, and unlocking months |

Permissions the super admin can give each admin (**Super Admin → Admins**):

- View Today
- View Payroll
- Edit Attendance
- Approve Requests
- Edit PF
- Manage Employees
- Manage Advances
- Export Payroll
- Lock Payroll
- View Bank / Cash Split
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

## 5. Things to know

- **30 m is tight.** Indoor GPS is often only accurate to 10–40 m. If genuine employees get "too far" errors, raise the radius to 50 m or raise *Max GPS Accuracy*. Test from different corners of the office first.
- **Fake GPS:** no web app can fully block fake-GPS apps. The app flags check-ins with weak GPS, or with the **exact same coordinates** as another day or another person. Fake-GPS apps typically produce identical coordinates, while real GPS always varies a little. Check flagged selfies in **Admin → Today**.
- **Live camera:** the selfie opens the front camera inside the app. If a phone or browser blocks the camera inside the app, it falls back to the phone's camera, unless *Live Camera Only* = Yes.
- **Location and camera permission:** employees must allow both for the site. If they denied it, they open browser settings → Site settings → Location / Camera → Allow.
- **Payslip download:** if the PDF download doesn't start on a phone, use **Print → Save as PDF**.
- **Five wrong PIN attempts** lock that Employee ID for 15 minutes.
- **The morning rush:** selfies are uploaded before the app waits its turn to write to the sheet, so many people can check in at the same minute.
