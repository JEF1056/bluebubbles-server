import React, { useEffect, useState } from 'react';
import {
    Badge,
    Box,
    Button,
    Checkbox,
    Collapse,
    FormControl,
    FormHelperText,
    HStack,
    Input,
    Stack,
    Text,
    useBoolean
} from '@chakra-ui/react';
import { ipcRenderer } from 'electron';
import { useAppSelector } from '../../hooks';
import { onCheckboxToggle } from '../../actions/ConfigActions';
import {
    GoogleFindStatus,
    completeGfindOauthToken,
    disconnectGfind,
    getGfindStatus,
    openGfindVaultUnlock,
    startGfindAuth,
    syncGfindNow
} from '../../utils/IpcUtils';
import { showErrorToast, showSuccessToast } from '../../utils/ToastUtils';

export const GoogleFindIntegrationField = (): JSX.Element => {
    const enabled: boolean = Boolean(useAppSelector(state => state.config.enable_gfind) ?? false);
    const [status, setStatus] = useState<GoogleFindStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [showPaste, setShowPaste] = useBoolean(false);
    const [oauthToken, setOauthToken] = useState('');

    const loadStatus = async () => {
        try {
            const next = await getGfindStatus();
            setStatus(next);
        } catch {
            // Ignore initial load error if service is not ready
        }
    };

    useEffect(() => {
        loadStatus();
        const handler = (_: unknown, next: GoogleFindStatus) => setStatus(next);
        ipcRenderer.on('gfind-status-update', handler);
        return () => {
            ipcRenderer.removeListener('gfind-status-update', handler);
        };
    }, []);

    const handleSignIn = async () => {
        setBusy(true);
        try {
            const res = await startGfindAuth();
            if (!res?.ok) {
                showErrorToast({ id: 'gfind', description: res?.error ?? 'Failed to open Google Find Hub sign-in.' });
            }
        } catch (ex: any) {
            showErrorToast({ id: 'gfind', description: ex?.message ?? String(ex) });
        } finally {
            setBusy(false);
        }
    };

    const handlePasteSubmit = async () => {
        const trimmed = oauthToken.trim();
        if (!trimmed) {
            showErrorToast({ id: 'gfind', description: 'Paste your Google oauth_token value.' });
            return;
        }
        setBusy(true);
        try {
            const next = await completeGfindOauthToken(trimmed);
            setStatus(next);
            setOauthToken('');
            setShowPaste.off();
            showSuccessToast({ id: 'gfind', description: 'Google Find Hub signed in.' });
        } catch (ex: any) {
            showErrorToast({ id: 'gfind', description: ex?.message ?? String(ex) });
        } finally {
            setBusy(false);
        }
    };

    const handleUnlockVault = async () => {
        setBusy(true);
        try {
            const res = await openGfindVaultUnlock();
            if (!res?.ok) {
                showErrorToast({ id: 'gfind', description: res?.error ?? 'Failed to open E2EE unlock window.' });
            }
        } catch (ex: any) {
            showErrorToast({ id: 'gfind', description: ex?.message ?? String(ex) });
        } finally {
            setBusy(false);
        }
    };

    const handleSyncNow = async () => {
        setBusy(true);
        try {
            const next = await syncGfindNow();
            setStatus(next);
            if (next?.lastError) {
                showErrorToast({ id: 'gfind', description: next.lastError });
            } else {
                showSuccessToast({ id: 'gfind', description: 'Google Find Hub devices synced.' });
            }
        } catch (ex: any) {
            showErrorToast({ id: 'gfind', description: ex?.message ?? String(ex) });
        } finally {
            setBusy(false);
        }
    };

    const handleDisconnect = async () => {
        setBusy(true);
        try {
            const next = await disconnectGfind();
            setStatus(next);
            showSuccessToast({ id: 'gfind', description: 'Disconnected from Google Find Hub.' });
        } catch (ex: any) {
            showErrorToast({ id: 'gfind', description: ex?.message ?? String(ex) });
        } finally {
            setBusy(false);
        }
    };

    return (
        <FormControl>
            <Checkbox id='enable_gfind' isChecked={enabled} onChange={onCheckboxToggle}>
                Enable Google Find Hub (FMDN Tags & Android Devices)
            </Checkbox>
            <FormHelperText>
                <Text>
                    Merges Google Find Hub tags/earbuds into Items and Android phones/tablets into Devices, with E2EE location decryption and BLE GATT ringing.
                </Text>
            </FormHelperText>

            {enabled && (
                <Box mt={3} p={3} borderWidth='1px' borderRadius='md'>
                    <Stack spacing={3}>
                        <HStack spacing={2} flexWrap='wrap'>
                            <Badge colorScheme={status?.signedIn ? 'green' : 'gray'}>
                                {status?.signedIn ? 'Signed In' : 'Not Signed In'}
                            </Badge>
                            {status?.signedIn && (
                                <Badge colorScheme={status.e2eeUnlocked ? 'green' : status.ownerKeyResetRequired ? 'red' : 'orange'}>
                                    {status.e2eeUnlocked
                                        ? 'E2EE Unlocked'
                                        : status.ownerKeyResetRequired
                                            ? 'E2EE Key Reset Required'
                                            : 'E2EE Locked'}
                                </Badge>
                            )}
                            {status?.signedIn && (
                                <Badge colorScheme={status.fcmConnected ? 'teal' : 'gray'}>
                                    {status.fcmConnected ? 'FCM Connected' : 'FCM Offline'}
                                </Badge>
                            )}
                            {status?.signedIn && status.email && <Text fontSize='sm'>{status.email}</Text>}
                            {status?.signedIn && (
                                <Text fontSize='sm' color='gray.500'>
                                    {status.tagCount} tag(s) · {status.androidDeviceCount} Android device(s)
                                    {status.lastSync ? ` · Last sync ${new Date(status.lastSync).toLocaleTimeString()}` : ''}
                                </Text>
                            )}
                        </HStack>

                        {status?.lastError && (
                            <Text fontSize='xs' color='red.400'>
                                {status.lastError}
                            </Text>
                        )}

                        <HStack spacing={2} flexWrap='wrap'>
                            <Button size='sm' colorScheme='blue' isLoading={busy} onClick={handleSignIn}>
                                {status?.signedIn ? 'Re-authenticate Google' : 'Sign in with Google'}
                            </Button>
                            <Button size='sm' variant='outline' onClick={setShowPaste.toggle}>
                                {showPaste ? 'Hide Token Paste' : 'Paste oauth_token'}
                            </Button>
                            {status?.signedIn && (
                                <>
                                    <Button
                                        size='sm'
                                        colorScheme={status.e2eeUnlocked ? 'gray' : 'orange'}
                                        variant={status.e2eeUnlocked ? 'outline' : 'solid'}
                                        isLoading={busy}
                                        onClick={handleUnlockVault}
                                    >
                                        Unlock Encrypted Locations
                                    </Button>
                                    <Button size='sm' variant='outline' isLoading={busy} onClick={handleSyncNow}>
                                        Sync Now
                                    </Button>
                                    <Button size='sm' colorScheme='red' variant='ghost' isLoading={busy} onClick={handleDisconnect}>
                                        Disconnect
                                    </Button>
                                </>
                            )}
                        </HStack>

                        <Collapse in={showPaste} animateOpacity>
                            <HStack spacing={2}>
                                <Input
                                    size='sm'
                                    type='password'
                                    placeholder='oauth_token cookie value'
                                    value={oauthToken}
                                    onChange={(e) => setOauthToken(e.target.value)}
                                />
                                <Button size='sm' isLoading={busy} onClick={handlePasteSubmit}>
                                    Submit Token
                                </Button>
                            </HStack>
                        </Collapse>
                    </Stack>
                </Box>
            )}
        </FormControl>
    );
};
