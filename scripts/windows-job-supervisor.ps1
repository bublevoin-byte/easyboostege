param(
  [string]$Payload,
  [string]$DeletePayload,
  [string]$RequestPayload
)

$ErrorActionPreference = 'Stop'
$protocol = 'easyboost-windows-job-v1'
$controlProtocol = 'easyboost-windows-job-control-v1'
$proofProtocol = 'easyboost-windows-job-empty-v1'
$controlVariable = 'EASYBOOST_WINDOWS_JOB_CONTROL'
$environmentVariable = 'EASYBOOST_WINDOWS_JOB_TARGET_ENVIRONMENT'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace EasyBoost {
  public sealed class WindowsDeletePair {
    public bool DeleteFirstAfterDirectory { get; set; }
    public bool DeleteFirstBeforeDirectory { get; set; }
    public bool DeleteSecondAfterDirectory { get; set; }
    public bool DeleteSecondBeforeDirectory { get; set; }
    public string ExpectedBirthtimeNs { get; set; }
    public string ExpectedFileIndex { get; set; }
    public uint ExpectedLinks { get; set; }
    public string ExpectedSha256 { get; set; }
    public long ExpectedSize { get; set; }
    public string ExpectedVolumeSerial { get; set; }
    public string FirstPath { get; set; }
    public string SecondPath { get; set; }
  }

  public sealed class WindowsDeleteDirectory {
    public string ExpectedBirthtimeNs { get; set; }
    public string ExpectedFileIndex { get; set; }
    public string ExpectedVolumeSerial { get; set; }
    public string Path { get; set; }
  }

  public static class WindowsJob {
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NEW = 1;
    private const uint DELETE = 0x00010000;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint FILE_ATTRIBUTE_TEMPORARY = 0x00000100;
    private const uint FILE_FLAG_DELETE_ON_CLOSE = 0x04000000;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_FLAG_SEQUENTIAL_SCAN = 0x08000000;
    private const uint FILE_FLAG_WRITE_THROUGH = 0x80000000;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_DISPOSITION_FLAG_DELETE = 0x00000001;
    private const uint FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE = 0x00000010;
    private const uint FILE_DISPOSITION_FLAG_POSIX_SEMANTICS = 0x00000002;
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint INFINITE = 0xffffffff;
    private const uint INVALID_FILE_ATTRIBUTES = 0xffffffff;
    private const uint OPEN_EXISTING = 3;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int FileDispositionInfo = 4;
    private const int FileDispositionInfoEx = 21;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const uint STARTF_USESTDHANDLES = 0x00000100;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
      public long TotalUserTime;
      public long TotalKernelTime;
      public long ThisPeriodTotalUserTime;
      public long ThisPeriodTotalKernelTime;
      public uint TotalPageFaultCount;
      public uint TotalProcesses;
      public uint ActiveProcesses;
      public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
      public uint cb;
      public string lpReserved;
      public string lpDesktop;
      public string lpTitle;
      public uint dwX;
      public uint dwY;
      public uint dwXSize;
      public uint dwYSize;
      public uint dwXCountChars;
      public uint dwYCountChars;
      public uint dwFillAttribute;
      public uint dwFlags;
      public ushort wShowWindow;
      public ushort cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public uint dwProcessId;
      public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_TIME {
      public uint Low;
      public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION {
      public uint FileAttributes;
      public FILE_TIME CreationTime;
      public FILE_TIME LastAccessTime;
      public FILE_TIME LastWriteTime;
      public uint VolumeSerialNumber;
      public uint FileSizeHigh;
      public uint FileSizeLow;
      public uint NumberOfLinks;
      public uint FileIndexHigh;
      public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_DISPOSITION_INFO {
      [MarshalAs(UnmanagedType.Bool)]
      public bool DeleteFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_DISPOSITION_INFO_EX {
      public uint Flags;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(string fileName, uint desiredAccess, uint shareMode,
      IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes,
      IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateHardLink(string fileName, string existingFileName,
      IntPtr securityAttributes);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributes(string fileName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass,
      ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine,
      IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
      uint creationFlags, IntPtr environment, string currentDirectory,
      ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(IntPtr file,
      out BY_HANDLE_FILE_INFORMATION information);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int infoClass,
      ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(IntPtr file, int informationClass,
      ref FILE_DISPOSITION_INFO disposition, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(IntPtr file, int informationClass,
      ref FILE_DISPOSITION_INFO_EX disposition, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static Win32Exception LastError(string operation) {
      return new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    private static ulong FileIndex(BY_HANDLE_FILE_INFORMATION information) {
      return ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
    }

    private static long FileSize(BY_HANDLE_FILE_INFORMATION information) {
      return checked((long)(((ulong)information.FileSizeHigh << 32) |
        information.FileSizeLow));
    }

    private static BY_HANDLE_FILE_INFORMATION ExactFileInformation(IntPtr file,
        string expectedBirthtimeNs, string expectedFileIndex, long expectedSize,
        string expectedVolumeSerial,
        uint expectedLinks) {
      BY_HANDLE_FILE_INFORMATION information;
      if (!GetFileInformationByHandle(file, out information)) {
        throw LastError("GetFileInformationByHandle");
      }
      ulong parsedFileIndex;
      uint parsedVolumeSerial;
      if (!UInt32.TryParse(expectedVolumeSerial, NumberStyles.None, CultureInfo.InvariantCulture,
          out parsedVolumeSerial) ||
          !UInt64.TryParse(expectedFileIndex, NumberStyles.None, CultureInfo.InvariantCulture,
          out parsedFileIndex) || BirthtimeNs(information) != expectedBirthtimeNs ||
          FileIndex(information) != parsedFileIndex ||
          information.VolumeSerialNumber != parsedVolumeSerial ||
          FileSize(information) != expectedSize || information.NumberOfLinks != expectedLinks ||
          (information.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY |
            FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
        throw new InvalidOperationException("Windows recovery file identity changed");
      }
      return information;
    }

    private static string Sha256(IntPtr file) {
      using (var safe = new SafeFileHandle(file, false))
      using (var stream = new FileStream(safe, FileAccess.Read, 4096, false))
      using (var hash = SHA256.Create()) {
        return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "")
          .ToLowerInvariant();
      }
    }

    private static void MarkDelete(IntPtr file) {
      var disposition = new FILE_DISPOSITION_INFO_EX();
      disposition.Flags = FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS |
        FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE;
      if (SetFileInformationByHandle(file, FileDispositionInfoEx, ref disposition,
          (uint)Marshal.SizeOf(disposition))) return;
      var extendedError = Marshal.GetLastWin32Error();
      if (extendedError != 87 && extendedError != 50) {
        throw new Win32Exception(extendedError, "SetFileInformationByHandle");
      }
      var legacy = new FILE_DISPOSITION_INFO();
      legacy.DeleteFile = true;
      if (!SetFileInformationByHandle(file, FileDispositionInfo, ref legacy,
          (uint)Marshal.SizeOf(legacy))) throw LastError("SetFileInformationByHandle");
    }

    private sealed class OpenDeletePair {
      public WindowsDeletePair Specification;
      public IntPtr First = new IntPtr(-1);
      public IntPtr Second = new IntPtr(-1);
    }

    private static IntPtr OpenExactRecoveryPath(string path, uint flags) {
      var access = GENERIC_READ | DELETE;
      var share = FILE_SHARE_READ | FILE_SHARE_DELETE;
      var handle = CreateFile(path, access, share, IntPtr.Zero, OPEN_EXISTING, flags,
        IntPtr.Zero);
      if (handle == new IntPtr(-1)) throw LastError("CreateFile");
      return handle;
    }

    private static string BirthtimeNs(BY_HANDLE_FILE_INFORMATION information) {
      var ticks = ((ulong)information.CreationTime.High << 32) |
        information.CreationTime.Low;
      const ulong windowsToUnixTicks = 116444736000000000UL;
      if (ticks < windowsToUnixTicks) {
        throw new InvalidOperationException("Windows recovery directory birthtime is invalid");
      }
      return checked((ticks - windowsToUnixTicks) * 100UL)
        .ToString(CultureInfo.InvariantCulture);
    }

    private static void ValidateDirectory(IntPtr directory,
        WindowsDeleteDirectory expected) {
      BY_HANDLE_FILE_INFORMATION information;
      if (!GetFileInformationByHandle(directory, out information)) {
        throw LastError("GetFileInformationByHandle");
      }
      ulong parsedFileIndex;
      uint parsedVolumeSerial;
      if (expected == null || String.IsNullOrWhiteSpace(expected.Path) ||
          !UInt32.TryParse(expected.ExpectedVolumeSerial, NumberStyles.None,
            CultureInfo.InvariantCulture, out parsedVolumeSerial) ||
          !UInt64.TryParse(expected.ExpectedFileIndex, NumberStyles.None,
            CultureInfo.InvariantCulture, out parsedFileIndex) ||
          FileIndex(information) != parsedFileIndex ||
          information.VolumeSerialNumber != parsedVolumeSerial ||
          BirthtimeNs(information) != expected.ExpectedBirthtimeNs ||
          (information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
          (information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        throw new InvalidOperationException("Windows recovery directory identity changed");
      }
    }

    private static bool PathExists(string path) {
      var attributes = GetFileAttributes(path);
      if (attributes != INVALID_FILE_ATTRIBUTES) return true;
      var error = Marshal.GetLastWin32Error();
      if (error == 2 || error == 3) return false;
      throw new Win32Exception(error, "GetFileAttributes");
    }

    private static byte[] ExactControlRequestBytes(string protocol, string signal,
        string token) {
      if (String.IsNullOrWhiteSpace(protocol) ||
          (signal != "SIGTERM" && signal != "SIGKILL") || !IsLowerHexToken(token)) {
        throw new ArgumentException("invalid Windows control request");
      }
      return new UTF8Encoding(false).GetBytes(ControlRequest(protocol, signal, token));
    }

    private static void ValidateExactControlRequest(IntPtr request, byte[] expected) {
      BY_HANDLE_FILE_INFORMATION information;
      if (!GetFileInformationByHandle(request, out information)) {
        throw LastError("GetFileInformationByHandle");
      }
      if ((information.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY |
          FILE_ATTRIBUTE_REPARSE_POINT)) != 0 || information.NumberOfLinks != 1 ||
          FileSize(information) != expected.LongLength) {
        throw new InvalidOperationException("Windows control request identity is not exact");
      }
      var observed = new byte[expected.Length];
      using (var safe = new SafeFileHandle(request, false))
      using (var stream = new FileStream(safe, FileAccess.Read, 4096, false)) {
        stream.Position = 0;
        var offset = 0;
        while (offset < observed.Length) {
          var read = stream.Read(observed, offset, observed.Length - offset);
          if (read == 0) break;
          offset += read;
        }
        if (offset != observed.Length || stream.ReadByte() != -1) {
          throw new InvalidOperationException("Windows control request length changed");
        }
      }
      for (var index = 0; index < expected.Length; index += 1) {
        if (observed[index] != expected[index]) {
          throw new InvalidOperationException("Windows control request bytes are not exact");
        }
      }
    }

    private static string PrivateControlRequestPath(string directory) {
      var random = new byte[32];
      using (var generator = RandomNumberGenerator.Create()) generator.GetBytes(random);
      return Path.Combine(directory, ".easyboost-request-" +
        BitConverter.ToString(random).Replace("-", "").ToLowerInvariant() + ".tmp");
    }

    public static int PublishExactControlRequest(WindowsDeleteDirectory directory,
        string requestPath, string protocol, string signal, string token) {
      if (directory == null || String.IsNullOrWhiteSpace(directory.Path) ||
          !Path.IsPathRooted(directory.Path) || String.IsNullOrWhiteSpace(requestPath) ||
          !Path.IsPathRooted(requestPath)) {
        throw new ArgumentException("invalid Windows control request authority");
      }
      var requestName = signal == "SIGKILL" ? "kill.request" : "term.request";
      var exactDirectory = Path.GetFullPath(directory.Path);
      var exactRequest = Path.Combine(exactDirectory, requestName);
      if (!StringComparer.OrdinalIgnoreCase.Equals(Path.GetFullPath(requestPath), exactRequest)) {
        throw new ArgumentException("Windows control request path is not exact");
      }
      var expected = ExactControlRequestBytes(protocol, signal, token);
      var directoryHandle = new IntPtr(-1);
      var requestHandle = new IntPtr(-1);
      var temporaryHandle = new IntPtr(-1);
      string temporaryPath = null;
      try {
        directoryHandle = CreateFile(exactDirectory, 0, FILE_SHARE_READ | FILE_SHARE_WRITE,
          IntPtr.Zero, OPEN_EXISTING,
          FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
        if (directoryHandle == new IntPtr(-1)) throw LastError("CreateFile");
        ValidateDirectory(directoryHandle, directory);

        for (var attempt = 0; attempt < 8 && temporaryHandle == new IntPtr(-1); attempt += 1) {
          temporaryPath = PrivateControlRequestPath(exactDirectory);
          temporaryHandle = CreateFile(temporaryPath,
            GENERIC_READ | GENERIC_WRITE | DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            IntPtr.Zero, CREATE_NEW,
            FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE | FILE_FLAG_WRITE_THROUGH,
            IntPtr.Zero);
          if (temporaryHandle == new IntPtr(-1)) {
            var temporaryError = Marshal.GetLastWin32Error();
            if (temporaryError != 80 && temporaryError != 183) {
              throw new Win32Exception(temporaryError, "CreateFile");
            }
          }
        }
        if (temporaryHandle == new IntPtr(-1)) {
          throw new IOException("Windows control request candidate namespace is unavailable");
        }
        using (var safe = new SafeFileHandle(temporaryHandle, false))
          using (var stream = new FileStream(safe, FileAccess.ReadWrite, 4096, false)) {
            stream.Write(expected, 0, expected.Length);
            stream.Flush(true);
          }
        ValidateExactControlRequest(temporaryHandle, expected);
        if (!CreateHardLink(exactRequest, temporaryPath, IntPtr.Zero)) {
          var linkError = Marshal.GetLastWin32Error();
          if (linkError != 80 && linkError != 183) {
            throw new Win32Exception(linkError, "CreateHardLink");
          }
        }
        CloseExactHandle(ref temporaryHandle);
        requestHandle = CreateFile(exactRequest, GENERIC_READ, FILE_SHARE_READ,
          IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
        if (requestHandle == new IntPtr(-1)) throw LastError("CreateFile");
        ValidateExactControlRequest(requestHandle, expected);
        ValidateDirectory(directoryHandle, directory);
        return 0;
      } finally {
        if (requestHandle != new IntPtr(-1)) CloseHandle(requestHandle);
        if (temporaryHandle != new IntPtr(-1)) CloseHandle(temporaryHandle);
        if (directoryHandle != new IntPtr(-1)) CloseHandle(directoryHandle);
      }
    }

    private static void CloseExactHandle(ref IntPtr handle) {
      if (handle == new IntPtr(-1)) return;
      if (!CloseHandle(handle)) throw LastError("CloseHandle");
      handle = new IntPtr(-1);
    }

    private static void MarkPhase(OpenDeletePair pair, bool afterDirectory) {
      var specification = pair.Specification;
      var first = afterDirectory ? specification.DeleteFirstAfterDirectory :
        specification.DeleteFirstBeforeDirectory;
      var second = afterDirectory ? specification.DeleteSecondAfterDirectory :
        specification.DeleteSecondBeforeDirectory;
      if (first) MarkDelete(pair.First);
      if (second) MarkDelete(pair.Second);
    }

    private static void ClosePhase(OpenDeletePair pair, bool afterDirectory) {
      var specification = pair.Specification;
      var first = afterDirectory ? specification.DeleteFirstAfterDirectory :
        specification.DeleteFirstBeforeDirectory;
      var second = afterDirectory ? specification.DeleteSecondAfterDirectory :
        specification.DeleteSecondBeforeDirectory;
      if (first) CloseExactHandle(ref pair.First);
      if (second) CloseExactHandle(ref pair.Second);
    }

    private static void RequirePhasePathsAbsent(OpenDeletePair pair, bool afterDirectory) {
      var specification = pair.Specification;
      var first = afterDirectory ? specification.DeleteFirstAfterDirectory :
        specification.DeleteFirstBeforeDirectory;
      var second = afterDirectory ? specification.DeleteSecondAfterDirectory :
        specification.DeleteSecondBeforeDirectory;
      if ((first && PathExists(specification.FirstPath)) ||
          (second && PathExists(specification.SecondPath))) {
        throw new InvalidOperationException("Windows recovery late replacement survived deletion");
      }
    }

    public static int DeleteExactHardLinkBatch(WindowsDeletePair[] pairs,
        WindowsDeleteDirectory directory) {
      if (pairs == null || pairs.Length > 8 || (pairs.Length < 1 && directory == null)) {
        throw new ArgumentException("invalid Windows recovery deletion batch");
      }
      var opened = new OpenDeletePair[pairs.Length];
      var directoryHandle = new IntPtr(-1);
      var names = new System.Collections.Generic.HashSet<string>(
        StringComparer.OrdinalIgnoreCase);
      try {
        if (directory != null) {
          if (String.IsNullOrWhiteSpace(directory.Path) ||
              !Path.IsPathRooted(directory.Path)) {
            throw new ArgumentException("invalid Windows recovery deletion directory");
          }
          directoryHandle = OpenExactRecoveryPath(directory.Path,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
          ValidateDirectory(directoryHandle, directory);
        }
        for (var index = 0; index < pairs.Length; index += 1) {
          var specification = pairs[index];
          if (specification == null || String.IsNullOrWhiteSpace(specification.FirstPath) ||
              String.IsNullOrWhiteSpace(specification.SecondPath) ||
              !Path.IsPathRooted(specification.FirstPath) ||
              !Path.IsPathRooted(specification.SecondPath) ||
              !names.Add(specification.FirstPath) || !names.Add(specification.SecondPath) ||
              specification.ExpectedSize < 0 || specification.ExpectedLinks != 2 ||
              !IsLowerHexToken(specification.ExpectedSha256) ||
              (specification.DeleteFirstAfterDirectory &&
                specification.DeleteFirstBeforeDirectory) ||
              (specification.DeleteSecondAfterDirectory &&
                specification.DeleteSecondBeforeDirectory) ||
              (directory == null && (specification.DeleteFirstAfterDirectory ||
                specification.DeleteSecondAfterDirectory))) {
            throw new ArgumentException("invalid Windows recovery deletion pair");
          }
          var pair = new OpenDeletePair();
          pair.Specification = specification;
          opened[index] = pair;
          var flags = FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN;
          pair.First = OpenExactRecoveryPath(specification.FirstPath, flags);
          pair.Second = OpenExactRecoveryPath(specification.SecondPath, flags);
          var firstInformation = ExactFileInformation(pair.First,
            specification.ExpectedBirthtimeNs, specification.ExpectedFileIndex,
            specification.ExpectedSize,
            specification.ExpectedVolumeSerial, specification.ExpectedLinks);
          var secondInformation = ExactFileInformation(pair.Second,
            specification.ExpectedBirthtimeNs, specification.ExpectedFileIndex,
            specification.ExpectedSize,
            specification.ExpectedVolumeSerial, specification.ExpectedLinks);
          if (firstInformation.VolumeSerialNumber != secondInformation.VolumeSerialNumber ||
              FileIndex(firstInformation) != FileIndex(secondInformation) ||
              Sha256(pair.First) != specification.ExpectedSha256) {
            throw new InvalidOperationException("Windows recovery hard-link pair changed");
          }
        }
        foreach (var pair in opened) MarkPhase(pair, false);
        foreach (var pair in opened) ClosePhase(pair, false);
        foreach (var pair in opened) RequirePhasePathsAbsent(pair, false);
        if (directory != null) {
          MarkDelete(directoryHandle);
          CloseExactHandle(ref directoryHandle);
          if (PathExists(directory.Path)) {
            throw new InvalidOperationException(
              "Windows recovery late directory replacement survived deletion");
          }
        }
        foreach (var pair in opened) MarkPhase(pair, true);
        foreach (var pair in opened) ClosePhase(pair, true);
        foreach (var pair in opened) RequirePhasePathsAbsent(pair, true);
        return 0;
      } finally {
        for (var index = opened.Length - 1; index >= 0; index -= 1) {
          var pair = opened[index];
          if (pair == null) continue;
          if (pair.Second != new IntPtr(-1)) CloseHandle(pair.Second);
          if (pair.First != new IntPtr(-1)) CloseHandle(pair.First);
        }
        if (directoryHandle != new IntPtr(-1)) CloseHandle(directoryHandle);
      }
    }

    private static string Quote(string value) {
      if (value.Length > 0 && value.IndexOfAny(new [] { ' ', '\t', '\n', '\v', '"' }) < 0) {
        return value;
      }
      var result = new StringBuilder("\"");
      var slashes = 0;
      foreach (var character in value) {
        if (character == '\\') {
          slashes += 1;
          continue;
        }
        if (character == '"') {
          result.Append('\\', slashes * 2 + 1);
          result.Append(character);
          slashes = 0;
          continue;
        }
        result.Append('\\', slashes);
        slashes = 0;
        result.Append(character);
      }
      result.Append('\\', slashes * 2);
      result.Append('"');
      return result.ToString();
    }

    private static StringBuilder CommandLine(string command, string[] arguments) {
      var result = new StringBuilder(Quote(command));
      foreach (var argument in arguments) {
        result.Append(' ');
        result.Append(Quote(argument ?? ""));
      }
      return result;
    }

    private static uint ActiveProcesses(IntPtr job) {
      var info = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
      if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, ref info,
          (uint)Marshal.SizeOf(info), IntPtr.Zero)) {
        throw LastError("QueryInformationJobObject");
      }
      return info.ActiveProcesses;
    }

    private static int RemainingSettlementMilliseconds(Stopwatch deadline, int milliseconds) {
      var remaining = milliseconds - deadline.Elapsed.TotalMilliseconds;
      if (remaining <= 0) return 0;
      return Math.Max(1, Math.Min(milliseconds, (int)Math.Ceiling(remaining)));
    }

    private static bool WaitForSettlement(IntPtr job, Stopwatch deadline, int milliseconds,
        string controlProtocol, string controlToken, string termRequestPath,
        string killRequestPath, ref bool terminationRequested) {
      while (true) {
        if (ActiveProcesses(job) == 0) return true;
        if (!terminationRequested &&
            (HasControlRequest(killRequestPath, controlProtocol, "SIGKILL", controlToken) ||
              HasControlRequest(termRequestPath, controlProtocol, "SIGTERM", controlToken))) {
          if (!TerminateJobObject(job, 125)) throw LastError("TerminateJobObject");
          terminationRequested = true;
          if (ActiveProcesses(job) == 0) return true;
        }
        var remaining = RemainingSettlementMilliseconds(deadline, milliseconds);
        if (remaining == 0) return ActiveProcesses(job) == 0;
        Thread.Sleep(Math.Min(20, remaining));
      }
    }

    private static bool IsLowerHexToken(string value) {
      if (value == null || value.Length != 64) return false;
      foreach (var character in value) {
        if (!((character >= '0' && character <= '9') ||
            (character >= 'a' && character <= 'f'))) return false;
      }
      return true;
    }

    private static string ControlRequest(string protocol, string signal, string token) {
      return "{\"protocol\":\"" + protocol + "\",\"signal\":\"" + signal +
        "\",\"token\":\"" + token + "\"}\n";
    }

    private static bool HasControlRequest(string path, string protocol, string signal,
        string token) {
      try {
        return File.Exists(path) && File.ReadAllText(path, Encoding.UTF8) ==
          ControlRequest(protocol, signal, token);
      } catch (IOException) {
        return false;
      } catch (UnauthorizedAccessException) {
        return false;
      }
    }

    private static void PublishJobEmptyProof(IntPtr job, string path, string protocol,
        string token) {
      if (ActiveProcesses(job) != 0) {
        throw new InvalidOperationException("Windows Job Object is not empty at proof time");
      }
      var value = "{\"activeProcesses\":0,\"protocol\":\"" + protocol +
        "\",\"token\":\"" + token + "\"}\n";
      var bytes = new UTF8Encoding(false).GetBytes(value);
      using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write,
          FileShare.None, 4096, FileOptions.WriteThrough)) {
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush(true);
      }
    }

    private static IntPtr CreateEnvironmentBlock(string[] environment) {
      if (environment == null) throw new ArgumentNullException("environment");
      var ordered = (string[])environment.Clone();
      Array.Sort(ordered, StringComparer.OrdinalIgnoreCase);
      string previousName = null;
      var block = new StringBuilder();
      foreach (var entry in ordered) {
        var separator = entry == null ? -1 : entry.IndexOf('=');
        if (separator <= 0 || entry.IndexOf('\0') >= 0) {
          throw new ArgumentException("invalid Windows child environment");
        }
        var name = entry.Substring(0, separator);
        if (name.IndexOf('=') >= 0 || (previousName != null &&
            StringComparer.OrdinalIgnoreCase.Equals(previousName, name))) {
          throw new ArgumentException("ambiguous Windows child environment");
        }
        previousName = name;
        block.Append(entry);
        block.Append('\0');
      }
      block.Append('\0');
      if (ordered.Length == 0) block.Append('\0');
      return Marshal.StringToHGlobalUni(block.ToString());
    }

    public static int Run(string command, string[] arguments, string currentDirectory,
        int settlementMilliseconds, string[] environment, string controlProtocol,
        string controlToken, string termRequestPath, string killRequestPath,
        string proofProtocol, string proofToken, string proofPath) {
      if (String.IsNullOrWhiteSpace(command) || settlementMilliseconds <= 0) {
        throw new ArgumentException("invalid Windows job invocation");
      }
      if (String.IsNullOrWhiteSpace(controlProtocol) || !IsLowerHexToken(controlToken) ||
          String.IsNullOrWhiteSpace(termRequestPath) || String.IsNullOrWhiteSpace(killRequestPath) ||
          String.IsNullOrWhiteSpace(proofProtocol) || !IsLowerHexToken(proofToken) ||
          String.IsNullOrWhiteSpace(proofPath)) {
        throw new ArgumentException("invalid Windows job settlement authority");
      }
      IntPtr job = IntPtr.Zero;
      var process = new PROCESS_INFORMATION();
      var processCreated = false;
      var assigned = false;
      var environmentBlock = IntPtr.Zero;
      try {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw LastError("CreateJobObject");
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
            (uint)Marshal.SizeOf(limits))) throw LastError("SetInformationJobObject");

        var startup = new STARTUPINFO();
        startup.cb = (uint)Marshal.SizeOf(startup);
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        environmentBlock = CreateEnvironmentBlock(environment);
        if (!CreateProcess(null, CommandLine(command, arguments), IntPtr.Zero, IntPtr.Zero,
            true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, environmentBlock,
            currentDirectory, ref startup, out process)) {
          throw LastError("CreateProcess");
        }
        processCreated = true;
        if (!AssignProcessToJobObject(job, process.hProcess)) {
          throw LastError("AssignProcessToJobObject");
        }
        assigned = true;
        if (ResumeThread(process.hThread) == 0xffffffff) throw LastError("ResumeThread");
        var terminationRequested = false;
        while (true) {
          var waitResult = WaitForSingleObject(process.hProcess, 20);
          if (waitResult == WAIT_OBJECT_0) break;
          if (waitResult != WAIT_TIMEOUT) throw LastError("WaitForSingleObject");
          if (HasControlRequest(killRequestPath, controlProtocol, "SIGKILL", controlToken) ||
              HasControlRequest(termRequestPath, controlProtocol, "SIGTERM", controlToken)) {
            if (ActiveProcesses(job) != 0 && !TerminateJobObject(job, 125)) {
              throw LastError("TerminateJobObject");
            }
            terminationRequested = true;
            break;
          }
        }
        if (terminationRequested) {
          var settlementDeadline = Stopwatch.StartNew();
          if (!WaitForSettlement(job, settlementDeadline, settlementMilliseconds,
              controlProtocol, controlToken, termRequestPath, killRequestPath,
              ref terminationRequested)) {
            throw new InvalidOperationException("Windows Job Object descendants did not settle");
          }
          PublishJobEmptyProof(job, proofPath, proofProtocol, proofToken);
          return 125;
        }
        uint exitCode;
        if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw LastError("GetExitCodeProcess");
        var completionDeadline = Stopwatch.StartNew();
        var passiveMilliseconds = settlementMilliseconds / 2;
        if (!WaitForSettlement(job, completionDeadline, passiveMilliseconds,
            controlProtocol, controlToken, termRequestPath, killRequestPath,
            ref terminationRequested)) {
          if (!terminationRequested) {
            if (!TerminateJobObject(job, 125)) throw LastError("TerminateJobObject");
            terminationRequested = true;
          }
          if (!WaitForSettlement(job, completionDeadline, settlementMilliseconds,
              controlProtocol, controlToken, termRequestPath, killRequestPath,
              ref terminationRequested)) {
            throw new InvalidOperationException("Windows Job Object descendants did not settle");
          }
          PublishJobEmptyProof(job, proofPath, proofProtocol, proofToken);
          return exitCode == 0 ? 125 : unchecked((int)exitCode);
        }
        PublishJobEmptyProof(job, proofPath, proofProtocol, proofToken);
        return terminationRequested && exitCode == 0 ? 125 : unchecked((int)exitCode);
      } finally {
        if (processCreated && !assigned) {
          TerminateProcess(process.hProcess, 125);
          WaitForSingleObject(process.hProcess, (uint)Math.Max(1, settlementMilliseconds));
        }
        if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
        if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
        if (job != IntPtr.Zero) CloseHandle(job);
        if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
      }
    }
  }
}
'@

try {
  $modeCount = 0
  if (-not [string]::IsNullOrWhiteSpace($Payload)) { $modeCount += 1 }
  if (-not [string]::IsNullOrWhiteSpace($DeletePayload)) { $modeCount += 1 }
  if (-not [string]::IsNullOrWhiteSpace($RequestPayload)) { $modeCount += 1 }
  if ($modeCount -ne 1) { throw 'Windows job invocation modes overlap or are unavailable' }
  if (-not [string]::IsNullOrWhiteSpace($DeletePayload)) {
    $deleteJson = [Text.Encoding]::UTF8.GetString(
      [Convert]::FromBase64String($DeletePayload)
    )
    $delete = $deleteJson | ConvertFrom-Json
    $deletePairs = @($delete.pairs)
    if ($delete.protocol -ne 'easyboost-windows-job-delete-batch-v1' -or
        $deletePairs.Count -gt 8) {
      throw 'Windows job deletion protocol mismatch'
    }
    $nativePairs = @($deletePairs | ForEach-Object {
      if (-not [IO.Path]::IsPathRooted([string]$_.firstPath) -or
          -not [IO.Path]::IsPathRooted([string]$_.secondPath)) {
        throw 'Windows job deletion path is invalid'
      }
      $pair = New-Object EasyBoost.WindowsDeletePair
      $pair.DeleteFirstAfterDirectory = [bool]$_.deleteFirstAfterDirectory
      $pair.DeleteFirstBeforeDirectory = [bool]$_.deleteFirstBeforeDirectory
      $pair.DeleteSecondAfterDirectory = [bool]$_.deleteSecondAfterDirectory
      $pair.DeleteSecondBeforeDirectory = [bool]$_.deleteSecondBeforeDirectory
      $pair.ExpectedBirthtimeNs = [string]$_.expectedBirthtimeNs
      $pair.ExpectedFileIndex = [string]$_.expectedFileIndex
      $pair.ExpectedLinks = [uint32]$_.expectedLinks
      $pair.ExpectedSha256 = [string]$_.expectedSha256
      $pair.ExpectedSize = [long]$_.expectedSize
      $pair.ExpectedVolumeSerial = [string]$_.expectedVolumeSerial
      $pair.FirstPath = [string]$_.firstPath
      $pair.SecondPath = [string]$_.secondPath
      $pair
    })
    $nativeDirectory = $null
    if ($null -ne $delete.directory) {
      if (-not [IO.Path]::IsPathRooted([string]$delete.directory.path)) {
        throw 'Windows job deletion directory is invalid'
      }
      $nativeDirectory = New-Object EasyBoost.WindowsDeleteDirectory
      $nativeDirectory.ExpectedBirthtimeNs = [string]$delete.directory.expectedBirthtimeNs
      $nativeDirectory.ExpectedFileIndex = [string]$delete.directory.expectedFileIndex
      $nativeDirectory.ExpectedVolumeSerial = [string]$delete.directory.expectedVolumeSerial
      $nativeDirectory.Path = [string]$delete.directory.path
    }
    if ($deletePairs.Count -lt 1 -and $null -eq $nativeDirectory) {
      throw 'Windows job deletion protocol requires a pair or exact directory'
    }
    $status = [EasyBoost.WindowsJob]::DeleteExactHardLinkBatch(
      [EasyBoost.WindowsDeletePair[]]$nativePairs,
      [EasyBoost.WindowsDeleteDirectory]$nativeDirectory
    )
    exit $status
  }
  if (-not [string]::IsNullOrWhiteSpace($RequestPayload)) {
    $requestJson = [Text.Encoding]::UTF8.GetString(
      [Convert]::FromBase64String($RequestPayload)
    )
    $request = $requestJson | ConvertFrom-Json
    if ($request.protocol -ne 'easyboost-windows-job-request-publication-v1' -or
        $request.signal -notin @('SIGTERM', 'SIGKILL') -or
        -not [IO.Path]::IsPathRooted([string]$request.requestPath) -or
        $null -eq $request.directory -or
        -not [IO.Path]::IsPathRooted([string]$request.directory.path)) {
      throw 'Windows job request publication protocol mismatch'
    }
    $nativeDirectory = New-Object EasyBoost.WindowsDeleteDirectory
    $nativeDirectory.ExpectedBirthtimeNs = [string]$request.directory.expectedBirthtimeNs
    $nativeDirectory.ExpectedFileIndex = [string]$request.directory.expectedFileIndex
    $nativeDirectory.ExpectedVolumeSerial = [string]$request.directory.expectedVolumeSerial
    $nativeDirectory.Path = [string]$request.directory.path
    $status = [EasyBoost.WindowsJob]::PublishExactControlRequest(
      $nativeDirectory,
      [string]$request.requestPath,
      $controlProtocol,
      [string]$request.signal,
      [string]$request.token
    )
    exit $status
  }
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))
  $specification = $json | ConvertFrom-Json
  if ($specification.protocol -ne $protocol) { throw 'Windows job protocol mismatch' }
  $controlPayload = [Environment]::GetEnvironmentVariable($controlVariable, 'Process')
  [Environment]::SetEnvironmentVariable($controlVariable, $null, 'Process')
  if ([string]::IsNullOrWhiteSpace($controlPayload)) {
    throw 'Windows job control authority is unavailable'
  }
  $controlJson = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($controlPayload)
  )
  $control = $controlJson | ConvertFrom-Json
  if ($control.controlProtocol -ne $controlProtocol) {
    throw 'Windows job control protocol mismatch'
  }
  if ($control.proofProtocol -ne $proofProtocol) {
    throw 'Windows job proof protocol mismatch'
  }
  $environmentPayload = [Environment]::GetEnvironmentVariable($environmentVariable, 'Process')
  [Environment]::SetEnvironmentVariable($environmentVariable, $null, 'Process')
  if ([string]::IsNullOrWhiteSpace($environmentPayload)) {
    throw 'Windows job target environment is unavailable'
  }
  $environmentJson = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($environmentPayload)
  )
  $environmentSpecification = $environmentJson | ConvertFrom-Json
  if ($environmentSpecification.protocol -ne $protocol) {
    throw 'Windows job environment protocol mismatch'
  }
  $environment = @($environmentSpecification.entries | ForEach-Object {
    if ([string]::IsNullOrEmpty([string]$_.name)) {
      throw 'Windows job target environment name is invalid'
    }
    '{0}={1}' -f [string]$_.name, [string]$_.value
  })
  $arguments = @($specification.arguments | ForEach-Object { [string]$_ })
  $status = [EasyBoost.WindowsJob]::Run(
    [string]$specification.command,
    [string[]]$arguments,
    [string]$specification.cwd,
    [int]$specification.settlementMilliseconds,
    [string[]]$environment,
    [string]$control.controlProtocol,
    [string]$control.controlToken,
    [string]$control.termRequestPath,
    [string]$control.killRequestPath,
    [string]$control.proofProtocol,
    [string]$control.proofToken,
    [string]$control.proofPath
  )
  exit $status
} catch {
  [Console]::Error.WriteLine(
    'Windows Job Object supervision failed ({0})' -f $_.Exception.GetType().FullName
  )
  exit 126
}
