# bootCAN

A modern, cross-platform CAN/CAN FD network monitoring and analysis tool built with Rust and React.

## Features

- **Real-time Message Viewing**: Monitor CAN bus traffic with live filtering and search
- **Message Transmission**: Send individual or periodic CAN messages
- **Multiple Interface Support**: SocketCAN (Linux), PCAN USB (Windows/macOS), Virtual CAN
- **Bus Statistics**: Real-time bus load, error counters, and traffic metrics
- **Export**: Save traces to CSV format

## Technology Stack

- **Backend**: Rust with Tauri 2.0
- **Frontend**: React + TypeScript + Tailwind CSS
- **State Management**: Zustand
- **CAN Interfaces**: SocketCAN, PCAN-Basic API

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
- Install [PCAN-Basic API](https://www.peak-system.com/PCAN-Basic.239.0.html)

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
├── src/                    # React frontend
│   ├── components/         # UI components
│   ├── stores/             # Zustand state management
│   └── App.tsx             # Main application
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── core/           # Core CAN logic
│   │   ├── hal/            # Hardware abstraction layer
│   │   └── commands.rs     # Tauri IPC commands
│   └── Cargo.toml
├── package.json
└── README.md
```

## Usage

1. **Connect**: Select a CAN interface from the dropdown and click Connect
2. **Monitor**: View incoming messages in the message viewer
3. **Transmit**: Use the transmit panel to send CAN messages
4. **Filter**: Use the search box to filter messages by ID
5. **Export**: Click Export CSV to save the current trace

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

# Build for macOS (generates .dmg)
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
- **macOS**: `.dmg` files for both Intel and Apple Silicon
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
| PCAN USB | Windows | 🚧 Stub (needs PCAN-Basic) |
| PCAN USB | macOS | 🚧 Stub (needs PCBUSB) |

## License

MIT License - see LICENSE file for details.

## Roadmap

- [ ] DBC file parsing and signal decoding
- [ ] Trace file import/export (TRC, MF4)
- [ ] Signal plotting and dashboards
- [ ] Python scripting engine
- [ ] UDS diagnostics module

