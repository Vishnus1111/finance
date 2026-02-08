import React, { useEffect, useRef, useState } from 'react'
import 'jspreadsheet-ce/dist/jspreadsheet.css'
import 'jsuites/dist/jsuites.css'
import jspreadsheet from 'jspreadsheet-ce'
import { app, db, auth } from './firebase'
import { doc, getDoc, setDoc, collection, getDocs } from 'firebase/firestore'
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut } from 'firebase/auth'

export default function App() {
  const el = useRef(null)
  const sheetInstanceRef = useRef(null)
  const isInitializing = useRef(false)
  const [saveStatus, setSaveStatus] = useState('Ready')
  const [useLocalStorage, setUseLocalStorage] = useState(false) // Changed to false for Firestore
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [authMode, setAuthMode] = useState('login') // 'login' or 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [showFormatDialog, setShowFormatDialog] = useState(false)
  const [userFormat, setUserFormat] = useState(null) // 'weekly' or 'daily'
  const [showPassword, setShowPassword] = useState(false)
  // Firebase imported; no status banner shown

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser)
      if (currentUser) {
        // Check if user has format preference stored
        const userDocRef = doc(db, 'users', currentUser.uid)
        try {
          const userDoc = await getDoc(userDocRef)
          if (userDoc.exists() && userDoc.data().format) {
            setUserFormat(userDoc.data().format)
          } else {
            // New user - show format selection dialog
            setShowFormatDialog(true)
          }
        } catch (error) {
          console.error('Error fetching user format:', error)
        }
      }
      setLoading(false)
    })
    return () => unsubscribe()
  }, [])

  const handleLogin = async (e) => {
    e.preventDefault()
    setAuthError('')
    try {
      await signInWithEmailAndPassword(auth, email, password)
    } catch (error) {
      setAuthError(error.message)
    }
  }

  const handleSignup = async (e) => {
    e.preventDefault()
    setAuthError('')
    try {
      await createUserWithEmailAndPassword(auth, email, password)
      // Format dialog will be shown by the onAuthStateChanged listener
    } catch (error) {
      setAuthError(error.message)
    }
  }

  const handleFormatSelection = async (format) => {
    try {
      const userDocRef = doc(db, 'users', user.uid)
      await setDoc(userDocRef, { format }, { merge: true })
      setUserFormat(format)
      setShowFormatDialog(false)
    } catch (error) {
      console.error('Error saving format preference:', error)
    }
  }

  const handleLogout = async () => {
    try {
      await signOut(auth)
    } catch (error) {
      console.error('Logout error:', error)
    }
  }

  // Check if current user is a primary account
  const isPrimaryAccount = (email, format) => {
    if (format === 'weekly') {
      return email === 'weekline@gmail.com'
    } else if (format === 'daily') {
      return email === 'dailyline@gmail.com'
    }
    return false
  }

  useEffect(() => {
    if (!user || !userFormat) return // Don't initialize spreadsheet if no user or format not selected
    if (!el.current) return
    if (isInitializing.current) return // Prevent double init
    
    console.log('🚀 Initializing spreadsheet with format:', userFormat)
    
    isInitializing.current = true
    const element = el.current

    // Destroy any previous instance (React StrictMode mounts twice in dev)
    try {
      if (sheetInstanceRef.current) {
        jspreadsheet.destroy(element)
        sheetInstanceRef.current = null
      }
    } catch (e) {
      console.log('Destroy error (safe to ignore):', e.message)
    }

    // Ensure container is empty before creating
    element.innerHTML = ''

    const init = async () => {
      try {
      // Build columns config based on user's format preference
      const now = new Date()
      const year = now.getFullYear()
      const month = now.getMonth() // 0-based
      const daysInMonth = new Date(year, month + 1, 0).getDate()

      // Determine primary account email based on format
      const primaryEmail = userFormat === 'weekly' ? 'weekline@gmail.com' : 'dailyline@gmail.com'
      const isUserPrimary = isPrimaryAccount(user.email, userFormat)
      
      console.log(`📋 Loading settings from ${isUserPrimary ? 'own' : 'primary'} account (${primaryEmail})`)

      let fixedCols, dateCols, columns, weeklyTotalMeta, totalColumnsSet
      let sharedSettings = null

      // Try to load shared settings from primary account
      try {
        const primaryAccountRef = doc(db, 'primaryAccounts', userFormat, 'settings', 'columnConfig')
        const settingsSnap = await getDoc(primaryAccountRef)
        
        if (settingsSnap.exists()) {
          sharedSettings = settingsSnap.data()
          console.log('✅ Loaded shared settings from primary account')
        }
      } catch (err) {
        console.log('No shared settings found, using defaults')
      }

      // Use shared settings if available, otherwise defaults
      if (sharedSettings && sharedSettings.fixedCols && userFormat === sharedSettings.format) {
        fixedCols = sharedSettings.fixedCols
        console.log('✅ Using shared column configuration for', userFormat)
        
        if (userFormat === 'weekly') {
          // Date columns: numeric-only input with mask
          dateCols = Array.from({ length: daysInMonth }, (_, i) => {
            const day = i + 1
            const dd = String(day).padStart(2, '0')
            const mm = String(month + 1).padStart(2, '0')
            return { type: 'numeric', title: `${dd}/${mm}`, width: 90, mask: '#,##0' }
          })

          // Insert a weekly total column after every 7 date columns
          columns = [...fixedCols]
          weeklyTotalMeta = [] // { index, start, end }
          
          // Track actual column indices as we build the array
          let weekStartColIndex = fixedCols.length // First date column starts after fixed cols
          
          for (let i = 0; i < dateCols.length; i++) {
            columns.push(dateCols[i])
            
            // After every 7 date columns, add a total column
            if ((i + 1) % 7 === 0) {
              const weekNum = (i + 1) / 7
              const totalColIndex = columns.length // This will be the index of the total column
              
              columns.push({ type: 'numeric', title: `Total wk ${weekNum}`, width: 110, mask: '#,##0', readOnly: true })
              
              // Store: total column index, and the range of date columns for this week
              weeklyTotalMeta.push({ 
                index: totalColIndex, 
                start: weekStartColIndex, 
                end: weekStartColIndex + 6 
              })
              
              // Next week starts after this total column
              weekStartColIndex = columns.length
            }
          }
          
          // Track total columns and update state to prevent recursive onchange loops
          totalColumnsSet = new Set(weeklyTotalMeta.map(m => m.index))
        } else {
          // Daily format with shared settings
          dateCols = Array.from({ length: daysInMonth }, (_, i) => {
            const day = i + 1
            const dd = String(day).padStart(2, '0')
            const mm = String(month + 1).padStart(2, '0')
            return { type: 'numeric', title: `${dd}/${mm}`, width: 90, mask: '#,##0' }
          })

          columns = [...fixedCols, ...dateCols]
          weeklyTotalMeta = [] // No weekly totals for daily format
          totalColumnsSet = new Set() // No total columns
        }
      } else if (userFormat === 'weekly') {
        // Weekly format - use weekline account structure (defaults)
        fixedCols = [
          { type: 'text', title: 'பெயர்', width: 200 },
          { type: 'calendar', title: 'தேதி', width: 120, options: { format: 'dd/MM/yy' } },
          { type: 'text', title: 'முகவரி', width: 220 },
          { type: 'text', title: 'Address 2', width: 220 },
          { type: 'text', title: 'மகிமை', width: 120 },
          { type: 'numeric', title: '%', width: 140, mask: '#,##0' },
          { type: 'numeric', title: 'அடைப்பு', width: 100, mask: '#,##0' },
          { type: 'numeric', title: 'Amount', width: 140, mask: '#,##0' },
          { type: 'numeric', title: 'Balance', width: 140, mask: '#,##0', readOnly: true }
        ]

        // Date columns: numeric-only input with mask
        dateCols = Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1
          const dd = String(day).padStart(2, '0')
          const mm = String(month + 1).padStart(2, '0')
          return { type: 'numeric', title: `${dd}/${mm}`, width: 90, mask: '#,##0' }
        })

        // Insert a weekly total column after every 7 date columns
        columns = [...fixedCols]
        weeklyTotalMeta = [] // { index, start, end }
        
        // Track actual column indices as we build the array
        let weekStartColIndex = fixedCols.length // First date column starts after fixed cols
        
        for (let i = 0; i < dateCols.length; i++) {
          columns.push(dateCols[i])
          
          // After every 7 date columns, add a total column
          if ((i + 1) % 7 === 0) {
            const weekNum = (i + 1) / 7
            const totalColIndex = columns.length // This will be the index of the total column
            
            columns.push({ type: 'numeric', title: `Total wk ${weekNum}`, width: 110, mask: '#,##0', readOnly: true })
            
            // Store: total column index, and the range of date columns for this week
            weeklyTotalMeta.push({ 
              index: totalColIndex, 
              start: weekStartColIndex, 
              end: weekStartColIndex + 6 
            })
            
            // Next week starts after this total column
            weekStartColIndex = columns.length
          }
        }
        
        // Debug: log the meta to verify correct indices
        console.log('Weekly Total Meta:', JSON.stringify(weeklyTotalMeta))
        console.log('Columns structure:', columns.map((c, i) => `${i}: ${c.title}`).join(', '))

        // Track total columns and update state to prevent recursive onchange loops
        totalColumnsSet = new Set(weeklyTotalMeta.map(m => m.index))
      } else if (userFormat === 'daily') {
        // Daily format - use dailyline account structure (simpler, no weekly totals)
        fixedCols = [
          { type: 'text', title: 'Name', width: 200 },
          { type: 'calendar', title: 'Date', width: 120, options: { format: 'dd/MM/yy' } },
          { type: 'text', title: 'Address', width: 220 },
          { type: 'text', title: 'Address 2', width: 220 },
          { type: 'text', title: 'A/C No.', width: 180 },
          { type: 'text', title: 'Adv', width: 120 },
          { type: 'numeric', title: 'Amount 1', width: 140, mask: '#,##0' },
          { type: 'numeric', title: 'Amount', width: 140, mask: '#,##0' },
          { type: 'numeric', title: 'Balance', width: 140, mask: '#,##0', readOnly: true }
        ]

        // Date columns without weekly totals
        dateCols = Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1
          const dd = String(day).padStart(2, '0')
          const mm = String(month + 1).padStart(2, '0')
          return { type: 'numeric', title: `${dd}/${mm}`, width: 90, mask: '#,##0' }
        })

        columns = [...fixedCols, ...dateCols]
        weeklyTotalMeta = [] // No weekly totals for daily format
        totalColumnsSet = new Set() // No total columns
      }

      let isUpdatingTotals = false

      const findMetaForColumn = (colIndex) => {
        for (let i = 0; i < weeklyTotalMeta.length; i++) {
          const m = weeklyTotalMeta[i]
          if (colIndex >= m.start && colIndex <= m.end) return m
        }
        return null
      }

      // Helper: convert zero-based column index to Excel-like name (A, B, ..., AA)
      const colIndexToName = (index) => {
        let name = ''
        let i = index
        while (i >= 0) {
          const r = i % 26
          name = String.fromCharCode(65 + r) + name
          i = Math.floor(i / 26) - 1
          if (i < 0) break
        }
        return name
      }

      // Ensure exactly 50 columns
      if (columns.length < 50) {
        columns.push(
          ...Array.from({ length: 50 - columns.length }, (_, i) => ({ type: 'text', title: `Col ${columns.length + i + 1}`, width: 90 }))
        )
      } else if (columns.length > 50) {
        columns.splice(50)
      }

      // Initialize empty data with 300 rows (may be replaced by DB value)
      const rows = 300
      const cols = columns.length
      let data = Array.from({ length: rows }, () => Array(cols).fill(''))

      // Persistence: load from Firestore if available (user-specific + format-specific)
      const accountType = userFormat === 'weekly' ? 'weekline' : 'dailyline'
      const sheetId = `${accountType}-${year}-${month + 1}`
      const sheetRef = doc(db, 'users', user.uid, 'sheets', sheetId)

      console.log('Loading sheet from Firestore:', sheetId)

      // Declare spreadsheet instance and helpers BEFORE createSpreadsheet
      let spreadsheetInstance = null
      let isUpdating = false

      // Debounce helper
      const debounce = (fn, wait) => {
        let t
        return (...args) => {
          clearTimeout(t)
          t = setTimeout(() => fn(...args), wait)
        }
      }

      const getAllDataFromInstance = () => {
        const all = []
        try {
          for (let r = 0; r < rows; r++) {
            const rowArr = []
            for (let c = 0; c < cols; c++) {
              const v = spreadsheetInstance.getValueFromCoords(c, r)
              rowArr.push(v === undefined || v === null ? '' : v)
            }
            all.push(rowArr)
          }
        } catch (e) {
          console.error('Error reading data from instance', e)
        }
        return all
      }

      const saveToStorage = async () => {
        if (!spreadsheetInstance) {
          console.warn('Cannot save: spreadsheet not initialized')
          return
        }
        const rowsData = getAllDataFromInstance()
        
        // If primary account, save column configuration to shared settings
        if (!useLocalStorage && isPrimaryAccount(user.email, userFormat)) {
          try {
            const primaryAccountRef = doc(db, 'primaryAccounts', userFormat, 'settings', 'columnConfig')
            await setDoc(primaryAccountRef, {
              fixedCols: fixedCols,
              format: userFormat,
              updatedAt: new Date().toISOString(),
              updatedBy: user.email
            })
            console.log('✅ Primary account: Saved shared settings for all', userFormat, 'accounts')
          } catch (err) {
            console.error('Failed to save shared settings:', err)
          }
        }
        
        if (useLocalStorage) {
          const payload = {
            meta: { year, month, cols, rows, updatedAt: new Date().toISOString() },
            rows: rowsData
          }
          console.log('💾 Saving to localStorage...')
          try {
            localStorage.setItem(sheetId, JSON.stringify(payload))
            console.log('✅ Saved to localStorage successfully')
            setSaveStatus('Saved (localStorage)')
          } catch (err) {
            console.error('❌ Failed to save to localStorage:', err)
            setSaveStatus('Error: ' + err.message)
          }
        } else {
          // Save each account (row) as a separate document for data isolation
          console.log('💾 Saving to Firestore with account isolation...')
          setSaveStatus('Saving...')
          try {
            const accountsCollectionRef = doc(db, 'users', user.uid, 'sheets', sheetId)
            const batch = []
            
            // Store each non-empty row as a separate document in accounts subcollection
            for (let i = 0; i < rowsData.length; i++) {
              const row = rowsData[i]
              // Check if row has any data (not completely empty)
              const hasData = row.some(cell => cell !== null && cell !== undefined && cell !== '')
              
              if (hasData) {
                const accountDocRef = doc(db, 'users', user.uid, 'sheets', sheetId, 'accounts', `row_${i}`)
                batch.push(setDoc(accountDocRef, {
                  rowIndex: i,
                  data: row,
                  updatedAt: new Date().toISOString()
                }))
              }
            }
            
            // Save metadata separately
            await setDoc(accountsCollectionRef, {
              meta: { year, month, cols, rows, updatedAt: new Date().toISOString(), format: userFormat }
            }, { merge: true })
            
            // Execute all account saves
            await Promise.all(batch)
            
            console.log('✅ Saved to Firestore with account isolation successfully')
            setSaveStatus('Saved (Firestore)')
          } catch (err) {
            console.error('❌ Failed to save to Firestore:', err)
            setSaveStatus('Error: ' + err.message)
          }
        }
      }
      
      const saveDebounced = debounce(saveToStorage, 800)

      const updateWeeklyTotal = (rowIndex, meta) => {
        if (!spreadsheetInstance || isUpdating) return
        
        try {
          isUpdating = true
          let sum = 0
          for (let c = meta.start; c <= meta.end; c++) {
            const cellValue = spreadsheetInstance.getValueFromCoords(c, rowIndex)
            if (cellValue !== undefined && cellValue !== null && cellValue !== '') {
              const num = parseFloat(String(cellValue).replace(/,/g, ''))
              if (!isNaN(num)) sum += num
            }
          }
          
          console.log(`Row ${rowIndex}, Week total at col ${meta.index}: sum = ${sum}`)
          spreadsheetInstance.setValueFromCoords(meta.index, rowIndex, sum, true)
          
          // Style the total cell with green text using inline styles
          const cell = spreadsheetInstance.getCellFromCoords(meta.index, rowIndex)
          if (cell) {
            cell.style.color = 'green'
            cell.style.fontWeight = 'bold'
            cell.style.backgroundColor = '#e8f5e9'
          }
        } catch (err) {
          console.error('Error updating weekly total:', err)
        } finally {
          isUpdating = false
        }
      }

      // Balance calculation: Amount 1 - sum of all date columns
      const updateBalance = (rowIndex) => {
        if (!spreadsheetInstance || isUpdating) return
        
        try {
          isUpdating = true
          
          // Get Amount 1 (column 6)
          const amount1Value = spreadsheetInstance.getValueFromCoords(6, rowIndex)
          const amount1 = amount1Value ? parseFloat(String(amount1Value).replace(/,/g, '')) : 0
          
          // Sum all date columns (starting from column 9)
          let totalCollected = 0
          for (let c = 9; c < cols; c++) {
            // Skip weekly total columns
            if (totalColumnsSet.has(c)) continue
            
            const cellValue = spreadsheetInstance.getValueFromCoords(c, rowIndex)
            if (cellValue !== undefined && cellValue !== null && cellValue !== '') {
              const num = parseFloat(String(cellValue).replace(/,/g, ''))
              if (!isNaN(num)) totalCollected += num
            }
          }
          
          // Calculate balance
          const balance = amount1 - totalCollected
          
          console.log(`Row ${rowIndex}, Balance: ${amount1} - ${totalCollected} = ${balance}`)
          
          // Update Balance column (column 8)
          spreadsheetInstance.setValueFromCoords(8, rowIndex, balance, true)
          
          // Style the balance cell
          const cell = spreadsheetInstance.getCellFromCoords(8, rowIndex)
          if (cell) {
            if (balance > 0) {
              cell.style.color = 'orange'
              cell.style.fontWeight = 'bold'
            } else if (balance === 0) {
              cell.style.color = 'green'
              cell.style.fontWeight = 'bold'
            } else {
              cell.style.color = 'red'
              cell.style.fontWeight = 'bold'
            }
          }
        } catch (err) {
          console.error('Error updating balance:', err)
        } finally {
          isUpdating = false
        }
      }

      // Helper to get previous collection value for suggestions
      const getPreviousCollectionValue = (rowIndex, colIndex) => {
        // First, check the immediate previous day column (colIndex - 1)
        // If it has a valid non-"-" value, use that
        // Skip weekly total columns
        
        // Find the immediate previous non-total column
        let immediatePrevCol = colIndex - 1
        while (immediatePrevCol >= 9 && totalColumnsSet.has(immediatePrevCol)) {
          immediatePrevCol--
        }
        
        if (immediatePrevCol >= 9) {
          const prevDayValue = spreadsheetInstance.getValueFromCoords(immediatePrevCol, rowIndex)
          // If previous day has a valid value (not "-" or empty)
          if (prevDayValue !== undefined && prevDayValue !== null && prevDayValue !== '' && prevDayValue !== '-') {
            const numValue = parseFloat(String(prevDayValue).replace(/,/g, ''))
            if (!isNaN(numValue) && numValue !== 0) {
              return prevDayValue
            }
          }
        }
        
        // If previous day is "-" or empty, look further back for the last entered amount
        for (let c = immediatePrevCol - 1; c >= 9; c--) {
          // Skip weekly total columns
          if (totalColumnsSet.has(c)) continue
          
          const cellValue = spreadsheetInstance.getValueFromCoords(c, rowIndex)
          if (cellValue !== undefined && cellValue !== null && cellValue !== '' && cellValue !== '-') {
            // Parse the value to check if it's not zero
            const numValue = parseFloat(String(cellValue).replace(/,/g, ''))
            if (!isNaN(numValue) && numValue !== 0) {
              return cellValue
            }
          }
        }
        
        // If no previous collection found, return the Amount value (column 7)
        const amountValue = spreadsheetInstance.getValueFromCoords(7, rowIndex)
        return amountValue || ''
      }

      // Function to apply styling to all Balance and Total columns after data loads
      const applyAllCellStyles = () => {
        if (!spreadsheetInstance) return
        
        console.log('Applying cell styles to all rows...')
        
        for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
          // Style Balance column (column 8)
          const balanceValue = spreadsheetInstance.getValueFromCoords(8, rowIndex)
          if (balanceValue !== undefined && balanceValue !== null && balanceValue !== '') {
            const balance = parseFloat(String(balanceValue).replace(/,/g, ''))
            if (!isNaN(balance)) {
              const cell = spreadsheetInstance.getCellFromCoords(8, rowIndex)
              if (cell) {
                if (balance > 0) {
                  cell.style.color = 'orange'
                  cell.style.fontWeight = 'bold'
                } else if (balance === 0) {
                  cell.style.color = 'green'
                  cell.style.fontWeight = 'bold'
                } else {
                  cell.style.color = 'red'
                  cell.style.fontWeight = 'bold'
                }
              }
            }
          }
          
          // Style all weekly total columns
          weeklyTotalMeta.forEach(meta => {
            const totalValue = spreadsheetInstance.getValueFromCoords(meta.index, rowIndex)
            if (totalValue !== undefined && totalValue !== null && totalValue !== '') {
              const cell = spreadsheetInstance.getCellFromCoords(meta.index, rowIndex)
              if (cell) {
                cell.style.color = 'green'
                cell.style.fontWeight = 'bold'
                cell.style.backgroundColor = '#e8f5e9'
              }
            }
          })
        }
        
        console.log('Cell styles applied successfully')
      }

      // Build and update the sticky bottom totals row
      const updateColumnTotals = () => {
        if (!spreadsheetInstance) return
        
        // Find the jexcel scroll container and the table inside it
        const jexcelContent = element.querySelector('.jexcel_content')
        const table = element.querySelector('.jexcel')
        if (!jexcelContent || !table) return
        
        // Calculate totals for each column
        const colTotals = Array(cols).fill(0)
        const colHasData = Array(cols).fill(false)
        
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const cellValue = spreadsheetInstance.getValueFromCoords(c, r)
            if (cellValue !== undefined && cellValue !== null && cellValue !== '' && cellValue !== '-') {
              const num = parseFloat(String(cellValue).replace(/,/g, ''))
              if (!isNaN(num)) {
                colTotals[c] += num
                colHasData[c] = true
              }
            }
          }
        }
        
        // Remove existing tfoot if any
        const existingTfoot = table.querySelector('tfoot.column-totals-footer')
        if (existingTfoot) existingTfoot.remove()
        
        // Create a tfoot element for proper alignment
        const tfoot = document.createElement('tfoot')
        tfoot.className = 'column-totals-footer'
        const tr = document.createElement('tr')
        
        // First cell: row number column (label "Total")
        const labelTd = document.createElement('td')
        labelTd.textContent = 'Total'
        labelTd.style.cssText = 'background:#2e7d32; color:#fff; font-weight:bold; font-size:12px; text-align:center; padding:6px 4px; border-right:1px solid #1b5e20; position:sticky; bottom:0; z-index:3;'
        tr.appendChild(labelTd)
        
        // Build cells for each column
        for (let colIdx = 0; colIdx < cols; colIdx++) {
          const td = document.createElement('td')
          const isDateCol = colIdx >= 9 && !totalColumnsSet.has(colIdx)
          const isTotalCol = totalColumnsSet.has(colIdx)
          const showTotal = isDateCol || isTotalCol
          
          let bgColor = '#2e7d32'
          if (isTotalCol) bgColor = '#1b5e20'
          
          td.style.cssText = `background:${bgColor}; color:#fff; font-weight:bold; font-size:12px; text-align:right; padding:6px 4px; border-right:1px solid #1b5e20; position:sticky; bottom:0; z-index:1;`
          
          if (showTotal && colHasData[colIdx]) {
            td.textContent = colTotals[colIdx].toLocaleString('en-IN')
          }
          
          tr.appendChild(td)
        }
        
        tfoot.appendChild(tr)
        table.appendChild(tfoot)
      }

      // Show suggestion buttons for a date cell
      const showSuggestions = (colIndex, rowIndex) => {
        setTimeout(() => {
          // Remove any existing suggestion boxes first
          const existingSuggestions = document.querySelectorAll('.suggestion-box')
          existingSuggestions.forEach(el => el.remove())
          
          // Get cell position
          const cellElement = spreadsheetInstance.getCellFromCoords(colIndex, rowIndex)
          if (!cellElement) return
          
          const rect = cellElement.getBoundingClientRect()
          const containerRect = element.getBoundingClientRect()
          
          // Create suggestion container
          const suggestionContainer = document.createElement('div')
          suggestionContainer.className = 'suggestion-box'
          suggestionContainer.style.position = 'absolute'
          suggestionContainer.style.top = (rect.bottom - containerRect.top) + 'px'
          suggestionContainer.style.left = (rect.left - containerRect.left) + 'px'
          suggestionContainer.style.width = rect.width + 'px'
          suggestionContainer.style.display = 'flex'
          suggestionContainer.style.gap = '2px'
          suggestionContainer.style.zIndex = '10000'
          suggestionContainer.style.marginTop = '2px'
          
          // Left suggestion (1st): previous day's value or last entered amount or Amount column
          const prevValue = getPreviousCollectionValue(rowIndex, colIndex)
          const leftBtn = document.createElement('button')
          leftBtn.textContent = prevValue || '0'
          leftBtn.className = 'suggestion-btn'
          leftBtn.style.flex = '1'
          leftBtn.style.padding = '4px 8px'
          leftBtn.style.backgroundColor = '#dbeafe'
          leftBtn.style.border = '1px solid #93c5fd'
          leftBtn.style.borderRadius = '4px'
          leftBtn.style.cursor = 'pointer'
          leftBtn.style.fontSize = '12px'
          leftBtn.style.fontWeight = '500'
          leftBtn.style.transition = 'all 0.2s'
          leftBtn.tabIndex = -1
          leftBtn.onmouseover = () => {
            leftBtn.style.backgroundColor = '#bfdbfe'
            leftBtn.style.transform = 'scale(1.05)'
          }
          leftBtn.onmouseout = () => {
            leftBtn.style.backgroundColor = '#dbeafe'
            leftBtn.style.transform = 'scale(1)'
          }
          leftBtn.onmousedown = (e) => {
            e.preventDefault()
            e.stopPropagation()
            
            // Remove suggestion box first
            suggestionContainer.remove()
            
            // Close the editor if open
            if (spreadsheetInstance.edition) {
              spreadsheetInstance.closeEditor(spreadsheetInstance.edition[0], false)
            }
            
            // Set the value
            setTimeout(() => {
              spreadsheetInstance.setValueFromCoords(colIndex, rowIndex, prevValue, true)
              
              // Force update weekly total and balance
              setTimeout(() => {
                isUpdating = false
                const meta = findMetaForColumn(colIndex)
                if (meta) updateWeeklyTotal(rowIndex, meta)
                setTimeout(() => {
                  isUpdating = false
                  updateBalance(rowIndex)
                  updateColumnTotals()
                  saveDebounced()
                }, 10)
              }, 10)
            }, 10)
          }
          leftBtn.onclick = (e) => {
            e.preventDefault()
            e.stopPropagation()
          }
          
          // Right suggestion (2nd): "-" (no payment for that day)
          const rightBtn = document.createElement('button')
          rightBtn.textContent = '-'
          rightBtn.className = 'suggestion-btn'
          rightBtn.style.flex = '1'
          rightBtn.style.padding = '4px 8px'
          rightBtn.style.backgroundColor = '#f3f4f6'
          rightBtn.style.border = '1px solid #d1d5db'
          rightBtn.style.borderRadius = '4px'
          rightBtn.style.cursor = 'pointer'
          rightBtn.style.fontSize = '12px'
          rightBtn.style.fontWeight = '500'
          rightBtn.style.transition = 'all 0.2s'
          rightBtn.tabIndex = -1
          rightBtn.onmouseover = () => {
            rightBtn.style.backgroundColor = '#e5e7eb'
            rightBtn.style.transform = 'scale(1.05)'
          }
          rightBtn.onmouseout = () => {
            rightBtn.style.backgroundColor = '#f3f4f6'
            rightBtn.style.transform = 'scale(1)'
          }
          rightBtn.onmousedown = (e) => {
            e.preventDefault()
            e.stopPropagation()
            
            // Remove suggestion box first
            suggestionContainer.remove()
            
            // Close the editor if open
            if (spreadsheetInstance.edition) {
              spreadsheetInstance.closeEditor(spreadsheetInstance.edition[0], false)
            }
            
            // Set the value
            setTimeout(() => {
              spreadsheetInstance.setValueFromCoords(colIndex, rowIndex, '-', true)
              
              // Force update weekly total and balance
              setTimeout(() => {
                isUpdating = false
                const meta = findMetaForColumn(colIndex)
                if (meta) updateWeeklyTotal(rowIndex, meta)
                setTimeout(() => {
                  isUpdating = false
                  updateBalance(rowIndex)
                  updateColumnTotals()
                  saveDebounced()
                }, 10)
              }, 10)
            }, 10)
          }
          rightBtn.onclick = (e) => {
            e.preventDefault()
            e.stopPropagation()
          }
          
          suggestionContainer.appendChild(leftBtn)
          suggestionContainer.appendChild(rightBtn)
          
          // Append to the spreadsheet container
          element.style.position = 'relative'
          element.appendChild(suggestionContainer)
        }, 10)
      }

      const createSpreadsheet = () => {
        if (sheetInstanceRef.current) {
          console.log('Spreadsheet already initialized; skipping re-init')
          return
        }
        // spreadsheetInstance will be created using the (possibly updated) `data`
        spreadsheetInstance = jspreadsheet(element, {
          data,
          columns,
          minDimensions: [cols, rows],
          defaultColWidth: 100,
          rowResize: true,
          columnResize: true,
          freezeColumns: 1,
          tableOverflow: true,
          tableWidth: '100%',
          tableHeight: '80vh',
          allowComments: true,
          fullscreen: false,
          toolbar: true,
          filters: true,
          rowHeaders: true,
          columnHeaders: true,
          allowInsertRow: true,
          allowManualInsertRow: true,
          allowDeleteRow: true,
          allowInsertColumn: false,
          allowManualInsertColumn: false,
          allowDeleteColumn: false,
          style: { backgroundColor: '#ffffff' },
          contextMenu: function(obj, x, y, e) {
            var items = [];
            if (y !== null) {
              items.push({ title: '⬆️ Move Row Up', onclick: function() { if (y > 0) { obj.moveRow(y, y - 1); } } });
              items.push({ title: '⬇️ Move Row Down', onclick: function() { obj.moveRow(y, y + 1); } });
              items.push({ type: 'line' });
              items.push({ title: 'Insert Row Above', onclick: function() { obj.insertRow(1, y, true); } });
              items.push({ title: 'Insert Row Below', onclick: function() { obj.insertRow(1, y, false); } });
              items.push({ title: 'Delete Row', onclick: function() { obj.deleteRow(y); } });
            }
            return items;
          },
          onselection: function(instance, x1, y1, x2, y2, origin) {
            const colIndex = parseInt(x1)
            const rowIndex = parseInt(y1)
            
            // Remove any existing suggestion boxes
            const existingSuggestions = document.querySelectorAll('.suggestion-box')
            existingSuggestions.forEach(el => el.remove())
            
            // Only show suggestions for date columns (col 9 onwards, excluding total columns)
            if (colIndex >= 9 && !totalColumnsSet.has(colIndex)) {
              showSuggestions(colIndex, rowIndex)
            }
          },
          oneditionstart: function(instance, cell, x, y, value) {
            const colIndex = parseInt(x)
            const rowIndex = parseInt(y)
            
            // Remove any existing suggestion boxes
            const existingSuggestions = document.querySelectorAll('.suggestion-box')
            existingSuggestions.forEach(el => el.remove())
            
            // Only show suggestions for date columns (col 9 onwards, excluding total columns)
            if (colIndex >= 9 && !totalColumnsSet.has(colIndex)) {
              showSuggestions(colIndex, rowIndex)
            }
          },
          oneditionend: function(instance, cell, x, y, value) {
            // Remove suggestion boxes when editing ends
            const suggestionBoxes = document.querySelectorAll('.suggestion-box')
            suggestionBoxes.forEach(box => box.remove())
          },
          onchange: function (instance, cell, colIndex, rowIndex, value) {
            console.log(`Cell changed: col=${colIndex}, row=${rowIndex}, value=${value}`)
            if (isUpdating) return
            const x = parseInt(colIndex)
            const y = parseInt(rowIndex)
            
            // Skip if this is a total column or balance column
            if (totalColumnsSet.has(x) || x === 8) return
            
            // Update weekly total if this is a date column
            const meta = findMetaForColumn(x)
            if (meta) setTimeout(() => updateWeeklyTotal(y, meta), 10)
            
            // Update balance if Amount 1 (col 6) or any date column (col 9+) changed
            if (x === 6 || x >= 9) {
              setTimeout(() => updateBalance(y), 20)
            }
            
            // Update bottom totals row
            setTimeout(() => updateColumnTotals(), 30)
            
            saveDebounced()
          }
        })

        try { sheetInstanceRef.current = spreadsheetInstance } catch (e) {}
        
        // Style the header row after spreadsheet is created
        setTimeout(() => {
          const headers = element.querySelectorAll('thead td')
          headers.forEach((header, index) => {
            const headerText = header.textContent.trim()
            
            // Balance column (column 8) - orange background
            if (index === 8 || headerText === 'Balance') {
              header.style.backgroundColor = '#FFA500'
              header.style.color = '#ffffff'
              header.style.fontWeight = 'bold'
            }
            // Weekly total columns - green background (only for weekly format)
            else if (userFormat === 'weekly' && headerText.startsWith('Total wk')) {
              header.style.backgroundColor = '#4CAF50'
              header.style.color = '#ffffff'
              header.style.fontWeight = 'bold'
            }
            // All other headers - sky blue background
            else {
              header.style.backgroundColor = '#87CEEB'
              header.style.color = '#000000'
              header.style.fontWeight = 'bold'
            }
          })
        }, 100)
      }

      // Try to load data from localStorage first, then Firestore
      const loadData = async () => {
        let loaded = false
        
        // Try localStorage first
        if (useLocalStorage) {
          try {
            const stored = localStorage.getItem(sheetId)
            if (stored) {
              const payload = JSON.parse(stored)
              if (payload && Array.isArray(payload.rows)) {
                data = payload.rows.map(r => Array.from({ length: cols }, (_, i) => (r[i] !== undefined ? r[i] : '')))
                if (data.length < rows) data = data.concat(Array.from({ length: rows - data.length }, () => Array(cols).fill('')))
                console.log('✅ Loaded from localStorage:', data.length, 'rows')
                loaded = true
              }
            }
          } catch (err) {
            console.error('Failed to load from localStorage:', err)
          }
        }
        
        // Try Firestore if localStorage didn't work - load isolated account data
        if (!loaded && !useLocalStorage) {
          try {
            // Load all account documents from the accounts subcollection
            const accountsCollectionRef = collection(db, 'users', user.uid, 'sheets', sheetId, 'accounts')
            const accountsSnapshot = await getDocs(accountsCollectionRef)
            
            if (!accountsSnapshot.empty) {
              console.log(`✅ Loading ${accountsSnapshot.size} isolated accounts from Firestore...`)
              
              // Initialize empty data array
              data = Array.from({ length: rows }, () => Array(cols).fill(''))
              
              // Load each account into its row position
              accountsSnapshot.forEach((docSnap) => {
                const accountData = docSnap.data()
                const rowIndex = accountData.rowIndex
                
                if (rowIndex >= 0 && rowIndex < rows && accountData.data) {
                  data[rowIndex] = Array.from({ length: cols }, (_, i) => (
                    accountData.data[i] !== undefined ? accountData.data[i] : ''
                  ))
                }
              })
              
              console.log('✅ Loaded isolated accounts from Firestore')
              loaded = true
            } else {
              console.log('No accounts found in Firestore, starting with empty sheet')
            }
          } catch (err) {
            console.error('Failed to load from Firestore:', err)
          }
        }
        
        createSpreadsheet()
        
        // Apply styling to all cells after spreadsheet is created and data is loaded
        setTimeout(() => {
          applyAllCellStyles()
          updateColumnTotals()
        }, 200)
        
        // Also update totals after a short delay to ensure DOM is ready
        setTimeout(() => {
          updateColumnTotals()
        }, 500)
      }
      
      loadData()

      // All helpers and variables now declared before createSpreadsheet

      } catch (error) {
        console.error('Failed to initialize spreadsheet', error)
      }
    }

    init()

    return () => {
      isInitializing.current = false
      try {
        if (sheetInstanceRef.current) {
          jspreadsheet.destroy(element)
          sheetInstanceRef.current = null
        }
        element.innerHTML = ''
      } catch (e) {
        console.log('Cleanup error (safe to ignore):', e.message)
      }
    }
  }, [user, userFormat])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-xl">Loading...</div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="bg-white p-8 rounded-lg shadow-md w-96">
          <h1 className="text-2xl font-bold mb-6 text-center">
            {authMode === 'login' ? 'Login' : 'Sign Up'}
          </h1>
          <form onSubmit={authMode === 'login' ? handleLogin : handleSignup}>
            <div className="mb-4">
              <label className="block text-sm font-medium mb-2">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium mb-2">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 pr-10"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500 hover:text-gray-700 focus:outline-none"
                >
                  {showPassword ? (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
            {authError && (
              <div className="mb-4 text-red-600 text-sm">{authError}</div>
            )}
            <button
              type="submit"
              className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition"
            >
              {authMode === 'login' ? 'Login' : 'Sign Up'}
            </button>
          </form>
          <div className="mt-4 text-center">
            <button
              onClick={() => {
                setAuthMode(authMode === 'login' ? 'signup' : 'login')
                setAuthError('')
              }}
              className="text-blue-600 hover:underline text-sm"
            >
              {authMode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Login'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Show format selection dialog for new users
  if (user && showFormatDialog) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="bg-white p-8 rounded-lg shadow-md w-96">
          <h1 className="text-2xl font-bold mb-6 text-center">Choose Your Format</h1>
          <p className="text-gray-600 mb-6 text-center">Select how you want to track your finances:</p>
          <div className="space-y-4">
            <button
              onClick={() => handleFormatSelection('weekly')}
              className="w-full bg-blue-600 text-white py-4 rounded-lg hover:bg-blue-700 transition font-medium text-lg"
            >
              📅 Weekly
            </button>
            <button
              onClick={() => handleFormatSelection('daily')}
              className="w-full bg-green-600 text-white py-4 rounded-lg hover:bg-green-700 transition font-medium text-lg"
            >
              📆 Daily
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Show loading if format not yet loaded
  if (user && !userFormat) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-xl">Loading format...</div>
      </div>
    )
  }

  const handleManualSave = async () => {
    if (sheetInstanceRef.current) {
      console.log('🔘 Manual save triggered')
      const instance = sheetInstanceRef.current
      // Force save by reading all data
      const rows = 300
      const cols = 50
      const allData = []
      for (let r = 0; r < rows; r++) {
        const row = []
        for (let c = 0; c < cols; c++) {
          const v = instance.getValueFromCoords(c, r)
          row.push(v === undefined || v === null ? '' : v)
        }
        allData.push(row)
      }
      
      const accountType = userFormat === 'weekly' ? 'weekline' : 'dailyline'
      const sheetId = `${accountType}-${new Date().getFullYear()}-${new Date().getMonth() + 1}`
      
      if (useLocalStorage) {
        const payload = { meta: { updatedAt: new Date().toISOString() }, rows: allData }
        localStorage.setItem(sheetId, JSON.stringify(payload))
        setSaveStatus('✅ Saved manually')
        console.log('✅ Manual save to localStorage complete')
      } else {
        // Save with account isolation - each row as separate document
        setSaveStatus('Saving manually...')
        try {
          const accountsCollectionRef = doc(db, 'users', user.uid, 'sheets', sheetId)
          const batch = []
          
          // Store each non-empty row as a separate document
          for (let i = 0; i < allData.length; i++) {
            const row = allData[i]
            const hasData = row.some(cell => cell !== null && cell !== undefined && cell !== '')
            
            if (hasData) {
              const accountDocRef = doc(db, 'users', user.uid, 'sheets', sheetId, 'accounts', `row_${i}`)
              batch.push(setDoc(accountDocRef, {
                rowIndex: i,
                data: row,
                updatedAt: new Date().toISOString()
              }))
            }
          }
          
          // Save metadata
          await setDoc(accountsCollectionRef, {
            meta: { updatedAt: new Date().toISOString(), format: userFormat }
          }, { merge: true })
          
          // Execute all saves
          await Promise.all(batch)
          
          setSaveStatus('✅ Saved manually')
          console.log('✅ Manual save to Firestore with account isolation complete')
        } catch (err) {
          setSaveStatus('❌ Save failed')
          console.error('❌ Manual save failed:', err)
        }
      }
    } else {
      console.error('No spreadsheet instance found')
    }
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Finance Spreadsheet - {userFormat === 'weekly' ? '📅 Weekly' : '📆 Daily'}</h1>
          {isPrimaryAccount(user.email, userFormat) && (
            <p className="text-sm text-orange-600 font-medium mt-1">
              🔑 Primary Account - Your settings apply to all {userFormat} accounts
            </p>
          )}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">Logged in as: {user.email}</span>
          <button 
            onClick={() => setUseLocalStorage(!useLocalStorage)}
            className="px-3 py-1 text-sm bg-gray-200 rounded hover:bg-gray-300 transition"
          >
            {useLocalStorage ? '💾 localStorage' : '☁️ Firestore'}
          </button>
          <span className="text-sm text-gray-600">Status: {saveStatus}</span>
          <button 
            onClick={handleManualSave}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
          >
            💾 Save Now
          </button>
          <button 
            onClick={handleLogout}
            className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition"
          >
            Logout
          </button>
        </div>
      </div>

      <div ref={el} style={{ width: '100%', minHeight: '80vh' }} />
    </div>
  )
}
