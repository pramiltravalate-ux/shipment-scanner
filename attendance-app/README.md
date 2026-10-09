# Employee Attendance & Salary App (Google Apps Script)

A mobile-friendly web app that runs on a Google Sheet. It lets employees:

- **Check in and check out** only when they are within **30 m of the office**, checked by GPS.
- **Take a selfie at check-in.** Photos are saved to a Google Drive folder.
- **See their month**: pick any month and see a colour-coded calendar (Absent, Half Day, OT, Late). Filter buttons highlight just one type. The month view also shows net OT and the salary breakdown, including PF, In Bank and In Cash for PF employees.
- **Keep the phone clock on automatic.** If the phone's time or time zone is wrong, the app blocks check-in/out and tells the employee to turn on "Automatic date & time". Recorded times always come from Google's server, not the phone.

An **admin dashboard** shows today's live attendance with selfies, the monthly payroll for every employee (with the In Bank / In Cash split), a calendar for each employee, a **PF Setup** screen to turn PF on or off and set amounts per employee, and a one-tap export of the payroll to a Sheet tab.

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
   This creates the tabs **Settings, Employees, Attendance and Holidays**, plus a Drive folder for selfies.
7. Fill in the Sheet (see section 2).
8. Deploy the app:
   - Click **Deploy → New deployment → ⚙ → Web app**.
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
   - Click **Deploy** and copy the **Web app URL**.
9. Send the URL to employees. On their phone, they open it in **Chrome** (Android) or **Safari** (iPhone) and tap **⋮ / Share → Add to Home Screen** to use it like an app.

> After you change the code, go to **Deploy → Manage deployments → ✏ Edit → Version: New version → Deploy**. This keeps the same URL.

---

## 2. Fill the Sheet

### Settings tab

| Setting | Default | Meaning |
|---|---|---|
| Company Name | My Company | Shown at the top of the app |
| **Office Latitude / Longitude** | *(empty)* | In Google Maps, **right-click your office → click the coordinates** to copy them. Paste the first number into Latitude and the second into Longitude |
| Allowed Radius (m) | **30** | How close to the office an employee must be |
| Max GPS Accuracy (m) | 50 | GPS readings less accurate than this are rejected |
| Check Location On Check-Out | Yes | Also require being at the office when checking out |
| Selfie Required | Yes | A selfie is needed at check-in |
| Shift Start | 09:30 | Used for late marking |
| Late Grace (min) | 10 | A check-in after 09:40 counts as **Late** |
| Standard Hours | **9** | Hours worked beyond this are **OT** |
| Salary Days Basis | **30** | Per day = salary ÷ 30, per hour = per day ÷ 9, per minute = per hour ÷ 60 |
| Full Day Min Hours | 8 | Hours needed for a full day |
| Half Day Min Hours | 4 | 4–8 h is a **Half Day**; under 4 h is **Absent** |
| No Check-Out Counts As | HALF_DAY | What happens when someone forgets to check out |
| OT Multiplier | **1.5** | OT pay = net OT minutes × per-minute rate × 1.5. **Set `1` to pay OT at the normal rate** |
| OT Block (min) | 0 | `0` counts every minute. `30` counts each day's OT only in full 30-minute blocks |
| Late Minutes Reduce OT | Yes | Net OT = the month's total OT minutes − the month's total late minutes |
| Weekly Off | Sunday | For example `Sunday` or `Saturday,Sunday` |
| Off-Day Work Is OT | Yes | All hours worked on a weekly off or holiday count as OT |
| Lates Per Half-Day Cut | 0 | Optional extra penalty: every N late marks deduct half a day (`0` = off) |
| Phone Time Tolerance (min) | 3 | Check-in is blocked if the phone clock is off by more than this |
| Default PF Bank Salary % | 90 | Used when an employee's *PF Bank Salary* is blank (90% of 15000 = 13500) |
| Default PF Employee % / Employer % | 12 / 13 | Used when *PF Employee* / *PF Employer* is blank (% of PF Bank Salary) |
| OT & Deductions Paid In | CASH | For PF employees: OT is added to, and leave/half-day deductions taken from, the **Cash** part (or `BANK`) |
| Currency | ₹ | |

### Employees tab

| Emp ID | Name | PIN | Monthly Salary | Role | Active | Join Date | Phone | PF Active | PF Bank Salary | PF Employee | PF Employer |
|---|---|---|---|---|---|---|---|---|---|---|---|
| E001 | Owner Name | 4821 | 30000 | ADMIN | Yes | 2026-01-01 | | No | | | |
| E002 | Ravi Kumar | 1111 | 15000 | EMPLOYEE | Yes | 2026-03-15 | | Yes | 13500 | 1721 | 1755 |

- Fill the **PF** columns here or, more easily, in the app under **Admin → PF Setup**: a switch plus three boxes per employee. A blank box uses the % defaults in Settings, and a value like `12%` also works.

- Give the **ADMIN** role to anyone who should see the admin dashboard. Admins can also mark their own attendance.
- To remove an employee, set **Active = No**. Their history is kept.
- **Change the sample PINs** (`1234`, `1111`) before going live.

### Holidays tab
Add one row per paid holiday: `2026-10-20 | Diwali`.

---

## 3. How salary is calculated

```
Per day    = Total Salary ÷ 30
Per hour   = Per day ÷ 9
Per minute = Per hour ÷ 60

Late minutes = check-in time − Shift Start   (only on days marked Late)
Net OT mins  = month's total OT minutes − month's total late minutes   (never below 0)
OT pay       = Net OT mins × Per minute × OT Multiplier

Leaves     = Absent days × Per day
Half Days  = Half days × ½ × Per day
Gross      = Total Salary + OT pay − Leaves − Half Days
```

**Employees without PF:** Net Salary = Gross.

**Employees with PF** (both the employee and admin screens show all of these):

| | Example: ₹15,000, full month |
|---|---|
| 1. Total Salary | 15,000 |
| 2. OT | + per calculation |
| 3. Leaves | − per calculation |
| 4. Half Days | − per calculation |
| 5. PF Employee | 1,721 (deducted) |
| 6. PF Employer | 1,755 (company contribution, shown only) |
| 7. **In Bank** = PF Bank Salary − PF Employee | 13,500 − 1,721 = **11,779** |
| 8. **In Cash** = Total Salary − PF Bank Salary, + OT − Leaves − Half Days | 15,000 − 13,500 = **1,500** |

The bank amount stays fixed, so the PF salary stays the same every month. OT and leave/half-day deductions change the **cash** part. If deductions are larger than the cash part, the rest comes out of the bank part. To put OT and deductions in the bank part instead, set *OT & Deductions Paid In* = `BANK`.

**Example with 1 absent day, 1 half day, 3h05m OT and 25 min late:** net OT = 185 − 25 = 160 min. OT pay = 160 × ₹0.926 = ₹148.15. Cash = 1,500 + 148.15 − 500 − 250 = **₹898.15**. Bank stays at **₹11,779**.

> PF and salary are read from the Employees tab every time, so changing them also changes how past months are shown. Click **Export payroll to Sheet** at each month end to keep a fixed record.

## 4. Admin corrections

All data is in the **Attendance** tab, so the admin can fix anything there directly:

- **Override Status** dropdown: `PRESENT`, `HALF_DAY`, `ABSENT` or `LEAVE`. This replaces the automatic status and removes the late mark for that day.
- **Paid leave:** add a row with the `Date` (`yyyy-MM-dd`), `Emp ID` and Override Status = `LEAVE`.
- **Forgot to check out:** type the time in **Check Out** (`18:30`).
- Use **Admin Note** for remarks. Employees see the note when they tap that day.

The dashboard recalculates everything from this tab, so corrections show up right away.

---

## 5. Things to know

- **30 m is tight.** Indoor GPS is often only accurate to 10–40 m. If genuine employees get "too far" errors, raise the radius to 50–100 m or raise *Max GPS Accuracy*. Test from different corners of the office first.
- **Fake-GPS apps** on Android can spoof location, and no web app can fully block them. The **selfie** is your main proof. Admins can view every selfie from the dashboard, and the distance and accuracy are stored for each check-in.
- **Location permission:** employees must allow location for the site. If they denied it, they need to open browser settings → Site settings → Location → Allow.
- **Login sessions** last 6 hours (the Apps Script cache limit). After that the app asks for the PIN again, with the Employee ID remembered.
- **Five wrong PIN attempts** lock that Employee ID for 15 minutes.
- PINs are stored in the Sheet, so keep the Sheet private and share it only with admins.
- Selfies are stored in your Drive folder "*Company* – Attendance Selfies" and use your Drive storage (about 40 KB each).
- Apps Script quotas comfortably cover a few hundred employees.
