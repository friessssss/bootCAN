#!/bin/bash

# Build script for bootCAN
# Generates releases for Windows (.exe) and macOS (.dmg)

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if we're in the right directory
if [ ! -f "package.json" ] || [ ! -d "src-tauri" ]; then
    print_error "Please run this script from the project root directory"
    exit 1
fi

# Extract version from package.json
VERSION=$(grep -o '"version": "[^"]*"' package.json | cut -d'"' -f4)
if [ -z "$VERSION" ]; then
    print_error "Failed to extract version from package.json"
    exit 1
fi
print_info "Building version: $VERSION"

# Create releases directory
RELEASES_DIR="releases"
mkdir -p "$RELEASES_DIR"

# Detect platform
PLATFORM=$(uname -s)
print_info "Detected platform: $PLATFORM"

# Function to build for macOS
build_macos() {
    print_info "Building for macOS..."
    
    # Build frontend
    print_info "Building frontend..."
    npm run build
    
    # Build Tauri app for macOS
    print_info "Building Tauri app for macOS (aarch64)..."
    npm run tauri build -- --target aarch64-apple-darwin || print_warn "aarch64 build reported errors, but continuing..."
    
    print_info "Building Tauri app for macOS (x86_64)..."
    npm run tauri build -- --target x86_64-apple-darwin || print_warn "x86_64 build reported errors, but continuing..."
    
    # Copy DMG files and app bundles to releases directory
    print_info "Copying macOS releases..."
    
    # Helper function to create DMG manually if Tauri's DMG creation failed
    create_dmg_manually() {
        local arch=$1
        local app_path="src-tauri/target/${arch}/release/bundle/macos/bootCAN.app"
        local dmg_name="bootCAN_${VERSION}_${arch}.dmg"
        local dmg_path="$RELEASES_DIR/$dmg_name"
        
        if [ -d "$app_path" ]; then
            print_info "Creating DMG manually for ${arch}..."
            # Create a temporary directory for DMG contents
            local temp_dir=$(mktemp -d)
            cp -R "$app_path" "$temp_dir/"
            
            # Create DMG using hdiutil
            hdiutil create -volname "bootCAN" -srcfolder "$temp_dir" -ov -format UDZO "$dmg_path" > /dev/null 2>&1
            
            if [ -f "$dmg_path" ]; then
                print_info "Successfully created ${dmg_name}"
                rm -rf "$temp_dir"
                return 0
            else
                print_warn "Failed to create DMG manually, copying .app bundle instead"
                cp -R "$app_path" "$RELEASES_DIR/bootCAN_${VERSION}_${arch}.app" 2>/dev/null || true
                rm -rf "$temp_dir"
                return 1
            fi
        fi
        return 1
    }
    
    # Helper function to find and copy DMG files
    copy_dmg_if_exists() {
        local arch=$1
        local arch_name=$2
        local target_dir="src-tauri/target/${arch}/release/bundle"
        
        # Check in dmg directory first (final location)
        local dmg_final="${target_dir}/dmg/bootCAN_${VERSION}_${arch_name}.dmg"
        local dmg_x64="${target_dir}/dmg/bootCAN_${VERSION}_x64.dmg"
        
        # Also check for any DMG file with the version pattern (Tauri might generate slightly different names)
        local dmg_pattern="${target_dir}/dmg/bootCAN_*.dmg"
        
        # Check in macos directory (temporary location if DMG script failed)
        local dmg_temp=$(find "${target_dir}/macos" -name "*.dmg" -type f 2>/dev/null | head -1)
        
        if [ -f "$dmg_final" ]; then
            cp "$dmg_final" "$RELEASES_DIR/" 2>/dev/null && print_info "Copied ${arch_name} DMG from dmg directory" && return 0
        elif [ -f "$dmg_x64" ] && [ "$arch_name" = "x86_64" ]; then
            cp "$dmg_x64" "$RELEASES_DIR/bootCAN_${VERSION}_${arch_name}.dmg" 2>/dev/null && print_info "Copied ${arch_name} DMG (renamed from x64)" && return 0
        elif [ -n "$dmg_temp" ] && [ -f "$dmg_temp" ]; then
            # Extract the actual DMG name from Tauri output and rename to our format
            local dmg_basename=$(basename "$dmg_temp")
            cp "$dmg_temp" "$RELEASES_DIR/bootCAN_${VERSION}_${arch_name}.dmg" 2>/dev/null && print_info "Copied ${arch_name} DMG from temporary location" && return 0
        fi
        
        return 1
    }
    
    # Try to copy DMG files (if they exist from Tauri build)
    print_info "Looking for aarch64 DMG..."
    if ! copy_dmg_if_exists "aarch64-apple-darwin" "aarch64"; then
        print_warn "aarch64 DMG not found, trying to create manually..."
        create_dmg_manually "aarch64-apple-darwin" || true
    fi
    
    print_info "Looking for x86_64 DMG..."
    if ! copy_dmg_if_exists "x86_64-apple-darwin" "x86_64"; then
        print_warn "x86_64 DMG not found, trying to create manually..."
        create_dmg_manually "x86_64-apple-darwin" || true
    fi
    
    print_info "macOS build complete! Files are in the $RELEASES_DIR directory"
}

# Function to build for Windows
build_windows() {
    print_info "Building for Windows..."
    
    # Check if we're on macOS (cross-compilation)
    if [ "$PLATFORM" = "Darwin" ]; then
        print_warn "Cross-compiling for Windows from macOS requires additional setup."
        print_warn "You may need to install the Windows target: rustup target add x86_64-pc-windows-msvc"
        print_warn "For best results, consider building on Windows or using GitHub Actions."
    fi
    
    # Build frontend
    print_info "Building frontend..."
    npm run build
    
    # Build Tauri app for Windows
    print_info "Building Tauri app for Windows..."
    npm run tauri build -- --target x86_64-pc-windows-msvc
    
    # Copy Windows installer/exe to releases directory
    print_info "Copying Windows releases..."
    
    # Copy MSI installer (Tauri generates with version in filename)
    if [ -d "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi" ]; then
        cp "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/"*.msi "$RELEASES_DIR/" 2>/dev/null || true
        print_info "Copied MSI installer(s)"
    fi
    
    # Copy NSIS installer (Tauri generates with version in filename)
    if [ -d "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis" ]; then
        cp "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/"*.exe "$RELEASES_DIR/" 2>/dev/null || true
        print_info "Copied NSIS installer(s)"
    fi
    
    # Also copy the standalone .exe if available
    if [ -f "src-tauri/target/x86_64-pc-windows-msvc/release/bootcan.exe" ]; then
        cp "src-tauri/target/x86_64-pc-windows-msvc/release/bootcan.exe" "$RELEASES_DIR/" 2>/dev/null || true
    fi
    
    print_info "Windows build complete! Installer/EXE files are in the $RELEASES_DIR directory"
}

# Function to build for current platform
build_current() {
    if [ "$PLATFORM" = "Darwin" ]; then
        build_macos
    elif [ "$PLATFORM" = "Linux" ]; then
        print_error "Linux builds are not currently configured"
        exit 1
    else
        print_error "Unknown platform: $PLATFORM"
        exit 1
    fi
}

# Parse command line arguments
case "${1:-}" in
    macos|mac|darwin)
        build_macos
        ;;
    windows|win)
        build_windows
        ;;
    all)
        print_info "Building for all platforms..."
        if [ "$PLATFORM" = "Darwin" ]; then
            build_macos
            build_windows
        else
            print_warn "Building 'all' is optimized for macOS. Building for current platform only."
            build_current
        fi
        ;;
    *)
        print_info "Building for current platform: $PLATFORM"
        print_info "Usage: ./build.sh [macos|windows|all]"
        build_current
        ;;
esac

print_info "Build process complete! Check the $RELEASES_DIR directory for output files."

