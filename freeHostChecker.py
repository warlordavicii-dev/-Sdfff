import socket
import ssl
import time
import os
from colorama import Fore, Style, init
from concurrent.futures import ThreadPoolExecutor, as_completed

init(autoreset=True)

# Proxy aur Port wahi hain
PROXY_HOST = "157.240.227.38"
PROXY_PORT = 8080

def generate_header(host):
    return (
        f"CONNECT {host}:443 HTTP/1.1\r\n"
        f"Host: {host}:443\r\n"
        "User-Agent: FBAV/0.0\r\n"
        "Proxy-Connection: Keep-Alive\r\n"
        "X-Iorg-Bsid: facebook\r\n"
        "\r\n"
    )

def get_status_code(response):
    try:
        first_line = response.split('\n')[0]
        if 'HTTP' in first_line.upper():
            parts = first_line.split()
            if len(parts) > 1:
                return parts[1]
    except:
        pass
    return "Unknown"

def test_host(host):
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(15)
        start_time = time.time()
        sock.connect((PROXY_HOST, PROXY_PORT))
        header = generate_header(host)
        sock.sendall(header.encode())
        response = sock.recv(4096).decode('utf-8', errors='ignore')
        elapsed_time = time.time() - start_time
        status = get_status_code(response)
        if status != "Unknown":
            return host, status, response, elapsed_time
        return None
    except Exception:
        return None
    finally:
        try:
            sock.close()
        except:
            pass

def main():
    os.system('cls' if os.name == 'nt' else 'clear')
    print(Fore.CYAN + "="*80)
    print(Fore.YELLOW + "           FREE BASICS HOST CHECKER (CUSTOM FILTERED)")
    print(Fore.CYAN + "="*80 + Style.RESET_ALL)
    
    file_path = input(Fore.WHITE + "Enter hosts file (e.g., host.txt): " + Style.RESET_ALL)
    if not os.path.exists(file_path):
        print(Fore.RED + "Error: File not found!")
        return

    with open(file_path, 'r') as f:
        hosts = [line.strip() for line in f if line.strip()]

    print(Fore.GREEN + f"\n[+] Total hosts: {len(hosts)}")
    print(Fore.CYAN + f"[+] Proxy: {PROXY_HOST}:{PROXY_PORT}")
    print(Fore.YELLOW + "[!] Scanning (Hiding 403)... \n" + Style.RESET_ALL)

    working = []
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(test_host, host): host for host in hosts}
        for future in as_completed(futures):
            result = future.result()
            if result:
                host, status, response, t = result
                
                # 403 ko bilkul ignore karne ke liye
                if status == "403":
                    continue

                # Rang set karne ke liye logic
                if status == "200":
                    color = Fore.GREEN
                elif status == "502":
                    color = Fore.RED
                elif status == "429":
                    color = Fore.YELLOW
                else:
                    color = Fore.WHITE # Baki statuses ke liye

                # Sirf selected status show honge
                if status in ["200", "502", "429"]:
                    working.append(result)
                    print(color + f"[FOUND] {host} -> Status: {status}" + Style.RESET_ALL)

    print(Fore.CYAN + "\n" + "="*80)
    print(Fore.YELLOW + "SCAN COMPLETE" + Style.RESET_ALL)
    print(Fore.CYAN + "="*80 + Style.RESET_ALL)
    
    if working:
        print(Fore.MAGENTA + "\nFILTERED RESULTS SUMMARY:" + Style.RESET_ALL)
        for host, status, _, _ in working:
            if status == "200": color = Fore.GREEN
            elif status == "502": color = Fore.RED
            elif status == "429": color = Fore.YELLOW
            print(color + f"   ✓ {host}  →  Status: {status}" + Style.RESET_ALL)
        
        print(Fore.CYAN + "\n" + "="*80 + Style.RESET_ALL)
        print(Fore.MAGENTA + "DETAILED RESPONSES (200, 502, 429 Only):" + Style.RESET_ALL)
        print(Fore.CYAN + "="*80 + Style.RESET_ALL)
        
        for host, status, response, t in working:
            if status == "200": color = Fore.GREEN
            elif status == "502": color = Fore.RED
            elif status == "429": color = Fore.YELLOW
            
            print(color + f"\n[{host}] → Status: {status} ({t:.2f}s)" + Style.RESET_ALL)
            preview = response[:700] + ("..." if len(response) > 700 else "")
            print(preview)
            print(Fore.CYAN + "-" * 65 + Style.RESET_ALL)
        
        if input(Fore.CYAN + "\nSave these filtered hosts to working_hosts.txt? (y/n): " + Style.RESET_ALL).lower() == 'y':
            with open("working_hosts.txt", "w", encoding="utf-8") as f:
                for host, _, _, _ in working:
                    f.write(host + "\n")
            print(Fore.GREEN + "✅ Saved successfully!" + Style.RESET_ALL)
    else:
        print(Fore.RED + "\nNo 200, 502, or 429 status hosts found." + Style.RESET_ALL)

if __name__ == "__main__":
    main()