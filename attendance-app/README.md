# Employee Attendance & Salary App (Google Apps Script)

A mobile-friendly web app that runs on a Google Sheet. It lets employees:

- **Check in and check out** only when they are within **30 m of the office**, checked by GPS.
- **Take a selfie at check-in.** Photos are saved to a Google Drive folder.
- **See their month**: a calendar of Present, Half Day, Absent, Late and Off days, OT hours and a live salary calculation.

An **admin dashboard** shows today's live attendance with selfies, the monthly payroll for every employee, a calendar for each employee and a one-tap export of the payroll to a Sheet tab.

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
| Full Day Min Hours | 8 | Hours needed for a full day |
| Half Day Min Hours | 4 | 4–8 h is a **Half Day**; under 4 h is **Absent** |
| No Check-Out Counts As | HALF_DAY | What happens when someone forgets to check out |
| OT Multiplier | **1.5** | OT pay = OT hours × hourly rate × 1.5. **Change this if your rate is different** (for example `1` or `2`) |
| OT Block (min) | 30 | OT is counted in complete 30-minute blocks (`0` = exact minutes) |
| Weekly Off | Sunday | For example `Sunday` or `Saturday,Sunday` |
| Off-Day Work Is OT | Yes | All hours worked on a weekly off or holiday count as OT |
| Lates Per Half-Day Cut | 3 | Every 3 late marks in a month deduct half a day (`0` = off) |
| Currency | ₹ | |

### Employees tab

| Emp ID | Name | PIN | Monthly Salary | Role | Active | Join Date | Phone |
|---|---|---|---|---|---|---|---|
| E001 | Owner Name | 4821 | 30000 | ADMIN | Yes | 2026-01-01 | |
| E002 | Ravi Kumar | 1111 | 18000 | EMPLOYEE | Yes | 2026-03-15 | |

- Give the **ADMIN** role to anyone who should see the admin dashboard. Admins can also mark their own attendance.
- To remove an employee, set **Active = No**. Their history is kept.
- **Change the sample PINs** (`1234`, `1111`) before going live.

### Holidays tab
Add one row per paid holiday: `2026-10-20 | Diwali`.

---

## 3. How salary is calculated

```
Per-day rate  = Monthly Salary ÷ days in that month
Hourly rate   = Per-day rate ÷ Standard Hours (9)

Deduction days = Absent days × 1
               + Half days × 0.5
               + days before the Join Date
               + 0.5 for every 3 late marks
Deduction      = Deduction days × Per-day rate

OT hours = (hours worked − 9) on working days, in 30-minute blocks
         + all hours worked on weekly offs and holidays
OT pay   = OT hours × Hourly rate × OT Multiplier

Net Salary = Monthly Salary − Deduction + OT pay
```

Weekly offs, holidays and **LEAVE** days are paid.
**Example:** ₹30,000 salary in a 30-day month, with 2 absent days, 1 half day, 3 late marks and 13.5 h OT:
deduction = 3 days × ₹1,000 = ₹3,000, OT pay = 13.5 × ₹111.11 × 1.5 = ₹2,250, **net = ₹29,250**.

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
