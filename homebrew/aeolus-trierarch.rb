class AeolusTrierarch < Formula
  desc "Crews the ships of an Aeolus fleet on this machine"
  homepage "https://github.com/ThomasHendrickx/aeolus-fleet-trierarch"
  version "@VERSION@"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "@DARWIN_ARM64_URL@"
      sha256 "@DARWIN_ARM64_SHA256@"
    end
    on_intel do
      url "@DARWIN_AMD64_URL@"
      sha256 "@DARWIN_AMD64_SHA256@"
    end
  end

  on_linux do
    on_arm do
      url "@LINUX_ARM64_URL@"
      sha256 "@LINUX_ARM64_SHA256@"
    end
    on_intel do
      url "@LINUX_AMD64_URL@"
      sha256 "@LINUX_AMD64_SHA256@"
    end
  end

  def install
    binary = Dir["aeolus-trierarch-*"].first
    chmod 0555, binary
    bin.install binary => "aeolus-trierarch"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/aeolus-trierarch --version --json")
  end
end
