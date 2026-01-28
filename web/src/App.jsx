import React, { useEffect, useRef, useState } from 'react'
import 'jspreadsheet-ce/dist/jspreadsheet.css'
import 'jsuites/dist/jsuites.css'
import jspreadsheet from 'jspreadsheet-ce'
import { app, db } from './firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'

export default function App() {
  const el = useRef(null)
  const sheetInstanceRef = useRef(null)
  const isInitializing = useRef(false)
  const [saveStatus, setSaveStatus] = useState('Ready')
  const [useLocalStorage, setUseLocalStorage] = useState(false) // Changed to false for Firestore
  // Firebase imported; no status banner shown

  useEffect(() => {
    if (!el.current) return
    if (isInitializing.current) return // Prevent double init
    
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
      // Build columns config: first 9 fixed fields, then current month dates from 10th
      const now = new Date()
      const year = now.getFullYear()
      const month = now.getMonth() // 0-based
      const daysInMonth = new Date(year, month + 1, 0).getDate()

      const fixedCols = [
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

      // Date columns: numeric-only input with mask
      const dateCols = Array.from({ length: daysInMonth }, (_, i) => {
        const day = i + 1
        const dd = String(day).padStart(2, '0')
        const mm = String(month + 1).padStart(2, '0')
        return { type: 'numeric', title: `${dd}/${mm}`, width: 90, mask: '#,##0' }
      })

      // Total columns up to 50; pad if needed
      // Insert a weekly total column after every 7 date columns
      const columns = [...fixedCols]
      const weeklyTotalMeta = [] // { index, start, end }
      
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
      const totalColumnsSet = new Set(weeklyTotalMeta.map(m => m.index))
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

      // Persistence: load from Firestore if available
      const sheetId = `sheet-${year}-${month + 1}`
      const sheetRef = doc(db, 'sheets', sheetId)

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
          // Convert array of arrays to object with numbered keys for Firestore
          const rowsObject = {}
          rowsData.forEach((row, index) => {
            rowsObject[index] = row
          })
          
          const payload = {
            meta: { year, month, cols, rows, updatedAt: new Date().toISOString() },
            rows: rowsObject // Object instead of array
          }
          
          console.log('💾 Saving to Firestore...')
          setSaveStatus('Saving...')
          try {
            await setDoc(sheetRef, payload, { merge: true })
            console.log('✅ Saved to Firestore successfully')
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
        // Look backward from the current column to find the last non-zero, non-empty value
        for (let c = colIndex - 1; c >= 9; c--) {
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
          oneditionstart: function(instance, cell, x, y, value) {
            const colIndex = parseInt(x)
            const rowIndex = parseInt(y)
            
            // Only show suggestions for date columns (col 9 onwards, excluding total columns)
            if (colIndex >= 9 && !totalColumnsSet.has(colIndex)) {
              // Use setTimeout to ensure editor is fully initialized
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
                
                // Left suggestion: "-" (no payment)
                const leftBtn = document.createElement('button')
                leftBtn.textContent = '-'
                leftBtn.className = 'suggestion-btn'
                leftBtn.style.flex = '1'
                leftBtn.style.padding = '4px 8px'
                leftBtn.style.backgroundColor = '#f3f4f6'
                leftBtn.style.border = '1px solid #d1d5db'
                leftBtn.style.borderRadius = '4px'
                leftBtn.style.cursor = 'pointer'
                leftBtn.style.fontSize = '12px'
                leftBtn.style.fontWeight = '500'
                leftBtn.style.transition = 'all 0.2s'
                leftBtn.tabIndex = -1
                leftBtn.onmouseover = () => {
                  leftBtn.style.backgroundColor = '#e5e7eb'
                  leftBtn.style.transform = 'scale(1.05)'
                }
                leftBtn.onmouseout = () => {
                  leftBtn.style.backgroundColor = '#f3f4f6'
                  leftBtn.style.transform = 'scale(1)'
                }
                leftBtn.onmousedown = (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  
                  // Set the value directly
                  spreadsheetInstance.setValueFromCoords(colIndex, rowIndex, '-')
                  
                  // Remove suggestion box and close editor
                  suggestionContainer.remove()
                }
                leftBtn.onclick = (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }
                
                // Right suggestion: previous day's value or Amount
                const prevValue = getPreviousCollectionValue(rowIndex, colIndex)
                const rightBtn = document.createElement('button')
                rightBtn.textContent = prevValue || '0'
                rightBtn.className = 'suggestion-btn'
                rightBtn.style.flex = '1'
                rightBtn.style.padding = '4px 8px'
                rightBtn.style.backgroundColor = '#dbeafe'
                rightBtn.style.border = '1px solid #93c5fd'
                rightBtn.style.borderRadius = '4px'
                rightBtn.style.cursor = 'pointer'
                rightBtn.style.fontSize = '12px'
                rightBtn.style.fontWeight = '500'
                rightBtn.style.transition = 'all 0.2s'
                rightBtn.tabIndex = -1
                rightBtn.onmouseover = () => {
                  rightBtn.style.backgroundColor = '#bfdbfe'
                  rightBtn.style.transform = 'scale(1.05)'
                }
                rightBtn.onmouseout = () => {
                  rightBtn.style.backgroundColor = '#dbeafe'
                  rightBtn.style.transform = 'scale(1)'
                }
                rightBtn.onmousedown = (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  
                  // Set the value directly
                  spreadsheetInstance.setValueFromCoords(colIndex, rowIndex, prevValue)
                  
                  // Remove suggestion box and close editor
                  suggestionContainer.remove()
                }
                rightBtn.onclick = (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }
                
                suggestionContainer.appendChild(leftBtn)
                suggestionContainer.appendChild(rightBtn)
                
                // Append to the spreadsheet container with higher priority
                element.style.position = 'relative'
                element.appendChild(suggestionContainer)
                
                console.log('Suggestions displayed for col:', colIndex, 'row:', rowIndex)
              }, 10)
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
            // Weekly total columns - green background
            else if (headerText.startsWith('Total wk')) {
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
        
        // Try Firestore if localStorage didn't work
        if (!loaded && !useLocalStorage) {
          try {
            const snap = await getDoc(sheetRef)
            if (snap && snap.exists()) {
              const payload = snap.data()
              if (payload && payload.rows) {
                // Handle both array and object formats
                let rowsArray
                if (Array.isArray(payload.rows)) {
                  rowsArray = payload.rows
                } else {
                  // Convert object back to array
                  rowsArray = Object.keys(payload.rows)
                    .sort((a, b) => parseInt(a) - parseInt(b))
                    .map(key => payload.rows[key])
                }
                
                data = rowsArray.map(r => Array.from({ length: cols }, (_, i) => (r[i] !== undefined ? r[i] : '')))
                if (data.length < rows) data = data.concat(Array.from({ length: rows - data.length }, () => Array(cols).fill('')))
                console.log('✅ Loaded from Firestore:', data.length, 'rows')
              }
            }
          } catch (err) {
            console.error('Failed to load from Firestore:', err)
          }
        }
        
        createSpreadsheet()
        
        // Apply styling to all cells after spreadsheet is created and data is loaded
        setTimeout(() => {
          applyAllCellStyles()
        }, 200)
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
  }, [])

  const handleManualSave = () => {
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
      
      const sheetId = `sheet-${new Date().getFullYear()}-${new Date().getMonth() + 1}`
      
      if (useLocalStorage) {
        const payload = { meta: { updatedAt: new Date().toISOString() }, rows: allData }
        localStorage.setItem(sheetId, JSON.stringify(payload))
        setSaveStatus('✅ Saved manually')
        console.log('✅ Manual save to localStorage complete')
      } else {
        // Convert to object format for Firestore
        const rowsObject = {}
        allData.forEach((row, index) => {
          rowsObject[index] = row
        })
        const payload = { meta: { updatedAt: new Date().toISOString() }, rows: rowsObject }
        
        setSaveStatus('Saving manually...')
        setDoc(doc(db, 'sheets', sheetId), payload, { merge: true })
          .then(() => {
            setSaveStatus('✅ Saved manually')
            console.log('✅ Manual save to Firestore complete')
          })
          .catch(err => {
            setSaveStatus('❌ Save failed')
            console.error('❌ Manual save failed:', err)
          })
      }
    } else {
      console.error('No spreadsheet instance found')
    }
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Finance Spreadsheet</h1>
        <div className="flex items-center gap-4">
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
        </div>
      </div>

      <div ref={el} />
    </div>
  )
}
