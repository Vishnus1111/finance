# Initial Account Setup

To create the initial account for aline@gmail.com:

1. Run the website
2. Click "Sign Up" 
3. Enter:
   - Email: aline@gmail.com
   - Password: aline@123
4. Click "Sign Up" button

The account will be created and you'll be automatically logged in.

## Authentication Features

- **Login**: Existing users can log in with their email and password
- **Sign Up**: New users can create an account
- **User-specific data**: Each user's spreadsheet data is stored separately in Firestore
- **Logout**: Users can log out using the Logout button in the top right
- **Session persistence**: Users remain logged in across browser sessions

## Data Storage

- Data is stored in Firestore under: `users/{userId}/sheets/{sheetId}`
- Each user has their own isolated data
- The sheet ID format is: `sheet-YEAR-MONTH` (e.g., `sheet-2026-1` for January 2026)
