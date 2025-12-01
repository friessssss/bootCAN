# bootCAN

A modern, cross-platform CAN/CAN FD network monitoring and analysis tool built with Rust and React.

**Version 0.2.0**

## Features

### Core Functionality
- **Real-time Message Viewing**: Monitor CAN bus traffic with live filtering and search
- **Multi-Channel Support**: Manage and monitor multiple CAN channels simultaneously
- **Message Transmission**: Send individual or periodic CAN messages with customizable timing
- **Advanced Filtering**: Filter messages by ID, data patterns, and custom criteria
- **Dual View Modes**: Switch between Monitor mode (statistics) and Trace mode (detailed history)
- **Signal Plotting & Visualization**: Real-time and trace-based plotting of decoded CAN signals with interactive charts

### DBC/SYM File Support
- **DBC File Parsing**: Load and parse standard DBC (Database CAN) files
- **SYM File Parsing**: Support for SYM format files
- **Signal Decoding**: Automatic signal extraction and decoding from loaded DBC/SYM files
- **Signal Inspector**: View decoded signals with physical values, units, and value names

### Signal Plotting & Visualization
- **Real-time Signal Plotting**: Visualize decoded CAN signals in real-time with live updating charts
- **Trace File Plotting**: Import and plot signals from TRC/CSV trace files with fast parallel processing
- **Multi-Signal Support**: Plot up to 10 signals simultaneously with distinct colors
- **Interactive Charts**: Zoom, pan, and cursor-based value inspection with time interpolation
- **Time Window Controls**: Adjustable time windows (10s, 20s, 30s, 60s, 5min, 10min, All)
- **Signal Selection**: Searchable multi-select signal picker with channel filtering
- **Performance Optimized**: Parallel processing for fast trace file loading and signal decoding

### Trace Management
- **Trace Logging**: Record CAN traffic to CSV or TRC format files
- **Trace Playback**: Load and replay recorded trace files with adjustable playback speed
- **Trace Import**: Fast import of large trace files (TRC/CSV) with progress indicators
- **CSV Export**: Export message traces to CSV format for analysis
- **Project Save/Load**: Save and restore complete project configurations

### Interface Support
- **SocketCAN** (Linux): Native support for Linux SocketCAN interfaces
- **PCAN USB** (Windows/macOS): Support for PEAK PCAN USB devices
- **Virtual CAN**: Built-in virtual CAN interface for testing and development

### Statistics & Monitoring
- **Real-time Bus Statistics**: Monitor bus load, message counts, and cycle times
- **Per-Channel Metrics**: Individual statistics for each CAN channel
- **Error Monitoring**: Track bus errors and connection status
- **Message Counters**: View message frequency and cycle time statistics

## Technology Stack

- **Backend**: Rust with Tauri 2.0
- **Frontend**: React 18 + TypeScript + Tailwind CSS
- **State Management**: Zustand
- **Charting**: uPlot (lightweight, high-performance canvas-based charts)
- **Parallel Processing**: Rayon (Rust) for multi-threaded signal decoding and file parsing
- **CAN Interfaces**: SocketCAN (Linux), PCAN-Basic API (Windows/macOS), Virtual CAN
- **File Formats**: DBC, SYM, CSV, TRC

## Prerequisites

### All Platforms
- [Node.js](https://nodejs.org/) 18+ and pnpm
- [Rust](https://rustup.rs/) 1.70+

### Linux (SocketCAN)
```bash
# Install can-utils for testing
sudo apt install can-utils

# Create a virtual CAN interface for testing
sudo modprobe vcan
sudo ip link add dev vcan0 type vcan
sudo ip link set up vcan0
```

### Windows/macOS (PCAN)
- Install [PCAN-Basic API](https://www.peak-system.com/PCAN-Basic.239.0.html) for Windows
- Install [PCBUSB](https://www.peak-system.com/PCBUSB.239.0.html) for macOS

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd bootCAN

# Install frontend dependencies
pnpm install

# Run in development mode
pnpm tauri dev

# Build for production
pnpm tauri build
```

## Project Structure

```
bootCAN/
├── src/                          # React frontend
│   ├── components/               # UI components
│   │   ├── ChannelManager.tsx    # Multi-channel management
│   │   ├── DbcManager.tsx       # DBC/SYM file management
│   │   ├── FilterPanel.tsx      # Advanced filtering
│   │   ├── MessageViewer.tsx    # Message display and decoding
│   │   ├── PlotPanel.tsx        # Signal plotting and visualization
│   │   ├── SignalInspector.tsx  # Signal decoding viewer
│   │   ├── SignalSelector.tsx   # Signal selection for plotting
│   │   ├── TraceManager.tsx     # Trace logging and playback
│   │   ├── TransmitPanel.tsx    # Message transmission
│   │   └── Toolbar.tsx          # Main toolbar controls
│   ├── stores/                   # Zustand state management
│   │   └── canStore.ts          # Main application state
│   └── App.tsx                   # Main application component
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── core/                 # Core CAN logic
│   │   │   ├── dbc/             # DBC/SYM parsing
│   │   │   │   ├── parser.rs    # DBC file parser
│   │   │   │   ├── sym_parser.rs # SYM file parser
│   │   │   │   └── models.rs    # Data models
│   │   │   ├── trace_logger.rs   # Trace file logging
│   │   │   ├── trace_player.rs  # Trace file playback (with parallel parsing)
│   │   │   ├── bus_stats.rs     # Bus statistics
│   │   │   └── message.rs       # CAN message models
│   │   ├── hal/                 # Hardware abstraction layer
│   │   │   ├── socketcan.rs     # SocketCAN implementation
│   │   │   ├── pcan.rs          # PCAN implementation
│   │   │   ├── virtual_can.rs   # Virtual CAN implementation
│   │   │   └── traits.rs        # Interface traits
│   │   └── commands.rs          # Tauri IPC commands (with batch decoding)
│   └── Cargo.toml
├── package.json
└── README.md
```

## Usage

### Getting Started

1. **Add a Channel**: Click "Add" in the Channel Manager to create a new CAN channel
2. **Select Interface**: Choose a CAN interface (SocketCAN, PCAN, or Virtual CAN)
3. **Configure Bitrate**: Set the CAN bus bitrate (125k, 250k, 500k, 1M)
4. **Load DBC/SYM**: Load a DBC or SYM file for the channel to enable signal decoding
5. **Connect**: Click "Connect" to start monitoring the CAN bus

### Monitoring Messages

- **View Messages**: Messages appear in real-time in the Message Viewer
- **Filter Messages**: Use the Filter Panel to filter by ID, data patterns, or custom criteria
- **Search**: Use the search box to quickly find messages by ID
- **View Modes**: Switch between Monitor mode (statistics) and Trace mode (full history)
- **Pause/Resume**: Pause message capture to inspect specific messages

### Working with DBC/SYM Files

1. **Load DBC/SYM**: Click "Load" in the DBC Manager or in a channel's DBC section
2. **Select File**: Choose a `.dbc` or `.sym` file
3. **View Decoded Signals**: Select a message in the Message Viewer to see decoded signals
4. **Signal Inspector**: The right panel shows physical values, units, and value names

### Transmitting Messages

1. **Open Transmit Panel**: Use the right sidebar Transmit Panel
2. **Configure Message**: Set ID, DLC, data bytes, and transmission type
3. **Send**: Click "Send" for one-time transmission or "Start Periodic" for repeated messages
4. **Monitor**: Transmitted messages appear in the Message Viewer with "TX" direction

### Signal Plotting

**Real-time Plotting:**
1. Switch to the **Plot** tab in the toolbar
2. Click "Add Signal" to open the signal selector
3. Search and select signals to plot (multi-select with checkboxes)
4. Signals will plot in real-time as messages arrive
5. Use controls to pause, clear data, or adjust time window

**Trace File Plotting:**
1. Switch to the **Plot** tab
2. Load DBC/SYM files for the channels used in the trace
3. Select signals to plot using "Add Signal"
4. Click "Import Trace" and select a TRC or CSV file
5. Progress bars show file loading and signal decoding progress
6. Chart displays all selected signals with interactive cursor

**Plot Controls:**
- **Time Window**: Adjust view window (10s, 20s, 30s, 60s, 5min, 10min, All)
- **Pause/Resume**: Pause real-time updates to inspect data
- **Clear Data**: Clear all plotted data
- **Cursor**: Hover to see interpolated values at any time point

### Trace Management

**Logging:**
1. Click "Start Logging" in the Trace Manager
2. Choose file format (CSV or TRC) and location
3. Messages are recorded to the file
4. Click "Stop Logging" to finish

**Playback:**
1. Click "Load Trace" to select a recorded trace file
2. Use playback controls (Play, Pause, Stop)
3. Adjust playback speed with the speed slider
4. Monitor playback progress in the status display

### Exporting Data

- **Export CSV**: Click "Export CSV" in the toolbar to export current messages
- **Save Project**: Use "Save Project" to save channel configurations and loaded DBC files
- **Load Project**: Use "Load Project" to restore a saved project

## Development

### Running Tests

```bash
# Rust backend tests
cd src-tauri
cargo test

# Frontend linting
pnpm lint
```

### Building for Release

The project includes a build script to generate platform-specific releases:

```bash
# Build for current platform (macOS on Mac, Windows on Windows)
npm run build:release
# or
./build.sh

# Build for macOS (generates .dmg for both Intel and Apple Silicon)
npm run build:macos
# or
./build.sh macos

# Build for Windows (generates .exe/.msi)
npm run build:windows
# or
./build.sh windows

# Build for all platforms (macOS + Windows)
npm run build:all
# or
./build.sh all
```

Built releases will be placed in the `releases/` directory:
- **macOS**: `.dmg` files for both Intel (x86_64) and Apple Silicon (aarch64)
- **Windows**: `.exe` installer and `.msi` package

**Note**: Cross-compiling Windows builds from macOS requires:
```bash
rustup target add x86_64-pc-windows-msvc
```

For best results, build Windows releases on a Windows machine or use CI/CD.

## Supported Hardware

| Interface | Platform | Status |
|-----------|----------|--------|
| Virtual CAN | All | ✅ Full support |
| SocketCAN | Linux | ✅ Full support |
| PCAN USB | Windows | ✅ Full support (requires PCAN-Basic) |
| PCAN USB | macOS | ✅ Full support (requires PCBUSB) |

## File Format Support

| Format | Type | Status |
|--------|------|--------|
| DBC | Database CAN | ✅ Full support |
| SYM | Symbol file | ✅ Full support |
| CSV | Trace export/import | ✅ Full support |
| TRC | Trace file | ✅ Full support (logging and playback) |

## License

MIT License - see LICENSE file for details.

## Roadmap

### Planned Features
- [ ] Python scripting engine
- [ ] UDS diagnostics module
- [ ] MF4 (MDF) file format support
- [ ] Advanced signal analysis tools (FFT, statistics, etc.)
- [ ] Custom message templates
- [ ] Export plots to image/PDF
- [ ] Signal comparison and diff tools

### Completed Features
- [x] DBC file parsing and signal decoding
- [x] SYM file format support
- [x] Trace file import/export (CSV, TRC)
- [x] Trace playback with speed control
- [x] Multi-channel support
- [x] Project save/load
- [x] Real-time bus statistics
- [x] Advanced filtering
- [x] Signal plotting and visualization (v0.2.0)
  - [x] Real-time signal plotting
  - [x] Trace file plotting with parallel processing
  - [x] Multi-signal support with interactive charts
  - [x] Time window controls and cursor-based inspection
