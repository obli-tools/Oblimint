-- MySQL dump 10.19  Distrib 10.3.39-MariaDB, for Linux (x86_64)
--
-- Host: localhost    Database: postfix_policyd
-- ------------------------------------------------------
-- Server version	10.3.39-MariaDB

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `access_control`
--

DROP TABLE IF EXISTS `access_control`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `access_control` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `PolicyID` bigint(20) unsigned DEFAULT NULL,
  `Name` varchar(255) NOT NULL,
  `Verdict` varchar(255) DEFAULT NULL,
  `Data` text DEFAULT NULL,
  `Comment` varchar(1024) DEFAULT NULL,
  `Disabled` smallint(6) NOT NULL DEFAULT 0,
  UNIQUE KEY `ID` (`ID`),
  KEY `PolicyID` (`PolicyID`),
  CONSTRAINT `access_control_ibfk_1` FOREIGN KEY (`PolicyID`) REFERENCES `policies` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `accounting`
--

DROP TABLE IF EXISTS `accounting`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `accounting` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `PolicyID` bigint(20) unsigned DEFAULT NULL,
  `Name` varchar(255) NOT NULL,
  `Track` varchar(255) NOT NULL,
  `AccountingPeriod` smallint(6) NOT NULL,
  `MessageCountLimit` bigint(20) unsigned DEFAULT NULL,
  `MessageCumulativeSizeLimit` bigint(20) unsigned DEFAULT NULL,
  `Verdict` varchar(255) DEFAULT NULL,
  `Data` text DEFAULT NULL,
  `LastAccounting` smallint(6) NOT NULL DEFAULT 0,
  `Comment` varchar(1024) DEFAULT NULL,
  `Disabled` smallint(6) NOT NULL DEFAULT 0,
  UNIQUE KEY `ID` (`ID`),
  KEY `PolicyID` (`PolicyID`),
  CONSTRAINT `accounting_ibfk_1` FOREIGN KEY (`PolicyID`) REFERENCES `policies` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `accounting_tracking`
--

DROP TABLE IF EXISTS `accounting_tracking`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `accounting_tracking` (
  `AccountingID` bigint(20) unsigned DEFAULT NULL,
  `TrackKey` varchar(512) DEFAULT NULL,
  `PeriodKey` varchar(512) DEFAULT NULL,
  `LastUpdate` bigint(20) unsigned DEFAULT NULL,
  `MessageCount` bigint(20) unsigned DEFAULT NULL,
  `MessageCumulativeSize` bigint(20) unsigned DEFAULT NULL,
  UNIQUE KEY `AccountingID` (`AccountingID`,`TrackKey`,`PeriodKey`),
  KEY `accounting_tracking_idx1` (`LastUpdate`),
  CONSTRAINT `accounting_tracking_ibfk_1` FOREIGN KEY (`AccountingID`) REFERENCES `accounting` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `amavis_rules`
--

DROP TABLE IF EXISTS `amavis_rules`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `amavis_rules` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `PolicyID` bigint(20) unsigned DEFAULT NULL,
  `Name` varchar(255) NOT NULL,
  `bypass_virus_checks` smallint(6) DEFAULT NULL,
  `bypass_virus_checks_m` smallint(6) NOT NULL DEFAULT 0,
  `bypass_banned_checks` smallint(6) DEFAULT NULL,
  `bypass_banned_checks_m` smallint(6) NOT NULL DEFAULT 0,
  `bypass_spam_checks` smallint(6) DEFAULT NULL,
  `bypass_spam_checks_m` smallint(6) NOT NULL DEFAULT 0,
  `bypass_header_checks` smallint(6) DEFAULT NULL,
  `bypass_header_checks_m` smallint(6) NOT NULL DEFAULT 0,
  `spam_tag_level` float DEFAULT NULL,
  `spam_tag_level_m` smallint(6) NOT NULL DEFAULT 0,
  `spam_tag2_level` float DEFAULT NULL,
  `spam_tag2_level_m` smallint(6) NOT NULL DEFAULT 0,
  `spam_tag3_level` float DEFAULT NULL,
  `spam_tag3_level_m` smallint(6) NOT NULL DEFAULT 0,
  `spam_kill_level` float DEFAULT NULL,
  `spam_kill_level_m` smallint(6) NOT NULL DEFAULT 0,
  `spam_dsn_cutoff_level` float DEFAULT NULL,
  `spam_dsn_cutoff_level_m` smallint(6) NOT NULL DEFAULT 0,
  `spam_quarantine_cutoff_level` float DEFAULT NULL,
  `spam_quarantine_cutoff_level_m` smallint(6) NOT NULL DEFAULT 0,
  `spam_modifies_subject` smallint(6) DEFAULT NULL,
  `spam_modifies_subject_m` smallint(6) NOT NULL DEFAULT 0,
  `spam_tag_subject` varchar(255) DEFAULT NULL,
  `spam_tag_subject_m` smallint(6) NOT NULL DEFAULT 0,
  `spam_tag2_subject` varchar(255) DEFAULT NULL,
  `spam_tag2_subject_m` smallint(6) NOT NULL DEFAULT 0,
  `spam_tag3_subject` varchar(255) DEFAULT NULL,
  `spam_tag3_subject_m` smallint(6) NOT NULL DEFAULT 0,
  `max_message_size` bigint(20) DEFAULT NULL,
  `max_message_size_m` smallint(6) NOT NULL DEFAULT 0,
  `banned_files` text DEFAULT NULL,
  `banned_files_m` smallint(6) NOT NULL DEFAULT 0,
  `sender_whitelist` text DEFAULT NULL,
  `sender_whitelist_m` smallint(6) NOT NULL DEFAULT 0,
  `sender_blacklist` text DEFAULT NULL,
  `sender_blacklist_m` smallint(6) NOT NULL DEFAULT 0,
  `notify_admin_newvirus` varchar(255) DEFAULT NULL,
  `notify_admin_newvirus_m` smallint(6) NOT NULL DEFAULT 0,
  `notify_admin_virus` varchar(255) DEFAULT NULL,
  `notify_admin_virus_m` smallint(6) NOT NULL DEFAULT 0,
  `notify_admin_spam` varchar(255) DEFAULT NULL,
  `notify_admin_spam_m` smallint(6) NOT NULL DEFAULT 0,
  `notify_admin_banned_file` varchar(255) DEFAULT NULL,
  `notify_admin_banned_file_m` smallint(6) NOT NULL DEFAULT 0,
  `notify_admin_bad_header` varchar(255) DEFAULT NULL,
  `notify_admin_bad_header_m` smallint(6) NOT NULL DEFAULT 0,
  `quarantine_virus` varchar(255) DEFAULT NULL,
  `quarantine_virus_m` smallint(6) NOT NULL DEFAULT 0,
  `quarantine_banned_file` varchar(255) DEFAULT NULL,
  `quarantine_banned_file_m` smallint(6) NOT NULL DEFAULT 0,
  `quarantine_bad_header` varchar(255) DEFAULT NULL,
  `quarantine_bad_header_m` smallint(6) NOT NULL DEFAULT 0,
  `quarantine_spam` varchar(255) DEFAULT NULL,
  `quarantine_spam_m` smallint(6) NOT NULL DEFAULT 0,
  `bcc_to` varchar(255) DEFAULT NULL,
  `bcc_to_m` smallint(6) NOT NULL DEFAULT 0,
  `Comment` varchar(1024) DEFAULT NULL,
  `Disabled` smallint(6) NOT NULL DEFAULT 0,
  UNIQUE KEY `ID` (`ID`),
  KEY `PolicyID` (`PolicyID`),
  CONSTRAINT `amavis_rules_ibfk_1` FOREIGN KEY (`PolicyID`) REFERENCES `policies` (`ID`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `checkhelo`
--

DROP TABLE IF EXISTS `checkhelo`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `checkhelo` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `PolicyID` bigint(20) unsigned DEFAULT NULL,
  `Name` varchar(255) NOT NULL,
  `UseBlacklist` smallint(6) DEFAULT NULL,
  `BlacklistPeriod` bigint(20) unsigned DEFAULT NULL,
  `UseHRP` smallint(6) DEFAULT NULL,
  `HRPPeriod` bigint(20) unsigned DEFAULT NULL,
  `HRPLimit` bigint(20) unsigned DEFAULT NULL,
  `RejectInvalid` smallint(6) DEFAULT NULL,
  `RejectIP` smallint(6) DEFAULT NULL,
  `RejectUnresolvable` smallint(6) DEFAULT NULL,
  `Comment` varchar(1024) DEFAULT NULL,
  `Disabled` smallint(6) NOT NULL DEFAULT 0,
  UNIQUE KEY `ID` (`ID`),
  KEY `PolicyID` (`PolicyID`),
  CONSTRAINT `checkhelo_ibfk_1` FOREIGN KEY (`PolicyID`) REFERENCES `policies` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `checkhelo_blacklist`
--

DROP TABLE IF EXISTS `checkhelo_blacklist`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `checkhelo_blacklist` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `Helo` varchar(255) NOT NULL,
  `Comment` varchar(1024) DEFAULT NULL,
  `Disabled` smallint(6) NOT NULL DEFAULT 0,
  UNIQUE KEY `ID` (`ID`),
  UNIQUE KEY `Helo` (`Helo`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `checkhelo_tracking`
--

DROP TABLE IF EXISTS `checkhelo_tracking`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `checkhelo_tracking` (
  `Address` varchar(64) NOT NULL,
  `Helo` varchar(255) NOT NULL,
  `LastUpdate` bigint(20) unsigned NOT NULL,
  UNIQUE KEY `Address` (`Address`,`Helo`),
  KEY `checkhelo_tracking_idx1` (`LastUpdate`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `checkhelo_whitelist`
--

DROP TABLE IF EXISTS `checkhelo_whitelist`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `checkhelo_whitelist` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `Source` varchar(512) NOT NULL,
  `Comment` varchar(1024) DEFAULT NULL,
  `Disabled` smallint(6) NOT NULL DEFAULT 0,
  UNIQUE KEY `ID` (`ID`),
  UNIQUE KEY `Source` (`Source`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `checkspf`
--

DROP TABLE IF EXISTS `checkspf`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `checkspf` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `PolicyID` bigint(20) unsigned DEFAULT NULL,
  `Name` varchar(255) NOT NULL,
  `UseSPF` smallint(6) DEFAULT NULL,
  `RejectFailedSPF` smallint(6) DEFAULT NULL,
  `AddSPFHeader` smallint(6) DEFAULT NULL,
  `Comment` varchar(1024) DEFAULT NULL,
  `Disabled` smallint(6) NOT NULL DEFAULT 0,
  UNIQUE KEY `ID` (`ID`),
  KEY `PolicyID` (`PolicyID`),
  CONSTRAINT `checkspf_ibfk_1` FOREIGN KEY (`PolicyID`) REFERENCES `policies` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `greylisting`
--

DROP TABLE IF EXISTS `greylisting`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `greylisting` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `PolicyID` bigint(20) unsigned DEFAULT NULL,
  `Name` varchar(255) NOT NULL,
  `UseGreylisting` smallint(6) DEFAULT NULL,
  `GreylistPeriod` bigint(20) unsigned DEFAULT NULL,
  `Track` varchar(255) NOT NULL,
  `GreylistAuthValidity` bigint(20) unsigned DEFAULT NULL,
  `GreylistUnAuthValidity` bigint(20) unsigned DEFAULT NULL,
  `UseAutoWhitelist` smallint(6) DEFAULT NULL,
  `AutoWhitelistPeriod` bigint(20) unsigned DEFAULT NULL,
  `AutoWhitelistCount` bigint(20) unsigned DEFAULT NULL,
  `AutoWhitelistPercentage` bigint(20) unsigned DEFAULT NULL,
  `UseAutoBlacklist` smallint(6) DEFAULT NULL,
  `AutoBlacklistPeriod` bigint(20) unsigned DEFAULT NULL,
  `AutoBlacklistCount` bigint(20) unsigned DEFAULT NULL,
  `AutoBlacklistPercentage` bigint(20) unsigned DEFAULT NULL,
  `Comment` varchar(1024) DEFAULT NULL,
  `Disabled` smallint(6) NOT NULL DEFAULT 0,
  UNIQUE KEY `ID` (`ID`),
  KEY `PolicyID` (`PolicyID`),
  CONSTRAINT `greylisting_ibfk_1` FOREIGN KEY (`PolicyID`) REFERENCES `policies` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `greylisting_autoblacklist`
--

DROP TABLE IF EXISTS `greylisting_autoblacklist`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `greylisting_autoblacklist` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `TrackKey` varchar(512) NOT NULL,
  `Added` bigint(20) unsigned NOT NULL,
  `Comment` varchar(1024) DEFAULT NULL,
  UNIQUE KEY `ID` (`ID`),
  UNIQUE KEY `TrackKey` (`TrackKey`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `greylisting_autowhitelist`
--

DROP TABLE IF EXISTS `greylisting_autowhitelist`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `greylisting_autowhitelist` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `TrackKey` varchar(512) NOT NULL,
  `Added` bigint(20) unsigned NOT NULL,
  `LastSeen` bigint(20) unsigned NOT NULL,
  `Comment` varchar(1024) DEFAULT NULL,
  UNIQUE KEY `ID` (`ID`),
  UNIQUE KEY `TrackKey` (`TrackKey`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `greylisting_tracking`
--

DROP TABLE IF EXISTS `greylisting_tracking`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `greylisting_tracking` (
  `TrackKey` varchar(512) NOT NULL,
  `Sender` varchar(255) NOT NULL,
  `Recipient` varchar(255) NOT NULL,
  `FirstSeen` bigint(20) unsigned NOT NULL,
  `LastUpdate` bigint(20) unsigned NOT NULL,
  `Tries` bigint(20) unsigned NOT NULL,
  `Count` bigint(20) unsigned NOT NULL,
  UNIQUE KEY `TrackKey` (`TrackKey`,`Sender`,`Recipient`),
  KEY `greylisting_tracking_idx1` (`LastUpdate`,`Count`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `greylisting_whitelist`
--

DROP TABLE IF EXISTS `greylisting_whitelist`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `greylisting_whitelist` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `Source` varchar(255) NOT NULL,
  `Comment` varchar(1024) DEFAULT NULL,
  `Disabled` smallint(6) NOT NULL DEFAULT 0,
  UNIQUE KEY `ID` (`ID`),
  UNIQUE KEY `Source` (`Source`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `policies`
--

DROP TABLE IF EXISTS `policies`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `policies` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `Name` varchar(255) NOT NULL,
  `Priority` smallint(6) NOT NULL,
  `Description` text DEFAULT NULL,
  `Disabled` smallint(6) NOT NULL DEFAULT 0,
  `PackageID` int(5) DEFAULT 0,
  UNIQUE KEY `ID` (`ID`)
) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `policy_group_members`
--

DROP TABLE IF EXISTS `policy_group_members`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `policy_group_members` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `PolicyGroupID` bigint(20) unsigned DEFAULT NULL,
  `Member` varchar(255) NOT NULL,
  `Disabled` smallint(6) NOT NULL DEFAULT 0,
  `Comment` varchar(1024) DEFAULT NULL,
  UNIQUE KEY `ID` (`ID`),
  KEY `PolicyGroupID` (`PolicyGroupID`),
  CONSTRAINT `policy_group_members_ibfk_1` FOREIGN KEY (`PolicyGroupID`) REFERENCES `policy_groups` (`ID`)
) ENGINE=InnoDB AUTO_INCREMENT=35 DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `policy_groups`
--

DROP TABLE IF EXISTS `policy_groups`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `policy_groups` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `Name` varchar(255) NOT NULL,
  `Disabled` smallint(6) NOT NULL DEFAULT 0,
  `Comment` varchar(1024) DEFAULT NULL,
  `PackageID` int(5) DEFAULT 0,
  UNIQUE KEY `ID` (`ID`),
  UNIQUE KEY `Name` (`Name`)
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `policy_members`
--

DROP TABLE IF EXISTS `policy_members`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `policy_members` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `PolicyID` bigint(20) unsigned DEFAULT NULL,
  `Source` text DEFAULT NULL,
  `Destination` text DEFAULT NULL,
  `Comment` varchar(1024) DEFAULT NULL,
  `Disabled` smallint(6) NOT NULL DEFAULT 0,
  UNIQUE KEY `ID` (`ID`),
  KEY `PolicyID` (`PolicyID`),
  CONSTRAINT `policy_members_ibfk_1` FOREIGN KEY (`PolicyID`) REFERENCES `policies` (`ID`)
) ENGINE=InnoDB AUTO_INCREMENT=38 DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `quotas`
--

DROP TABLE IF EXISTS `quotas`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `quotas` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `PolicyID` bigint(20) unsigned DEFAULT NULL,
  `Name` varchar(255) NOT NULL,
  `Track` varchar(255) NOT NULL,
  `Period` bigint(20) unsigned DEFAULT NULL,
  `Verdict` varchar(255) DEFAULT NULL,
  `Data` text DEFAULT NULL,
  `LastQuota` smallint(6) NOT NULL DEFAULT 0,
  `Comment` varchar(1024) DEFAULT NULL,
  `Disabled` smallint(6) NOT NULL DEFAULT 0,
  UNIQUE KEY `ID` (`ID`),
  KEY `PolicyID` (`PolicyID`),
  CONSTRAINT `quotas_ibfk_1` FOREIGN KEY (`PolicyID`) REFERENCES `policies` (`ID`)
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `quotas_limits`
--

DROP TABLE IF EXISTS `quotas_limits`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `quotas_limits` (
  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `QuotasID` bigint(20) unsigned DEFAULT NULL,
  `Type` varchar(255) DEFAULT NULL,
  `CounterLimit` bigint(20) unsigned DEFAULT NULL,
  `Comment` varchar(1024) DEFAULT NULL,
  `Disabled` smallint(6) NOT NULL DEFAULT 0,
  UNIQUE KEY `ID` (`ID`),
  KEY `QuotasID` (`QuotasID`),
  CONSTRAINT `quotas_limits_ibfk_1` FOREIGN KEY (`QuotasID`) REFERENCES `quotas` (`ID`)
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `quotas_tracking`
--

DROP TABLE IF EXISTS `quotas_tracking`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `quotas_tracking` (
  `QuotasLimitsID` bigint(20) unsigned DEFAULT NULL,
  `TrackKey` varchar(512) DEFAULT NULL,
  `LastUpdate` bigint(20) unsigned DEFAULT NULL,
  `Counter` decimal(10,4) DEFAULT NULL,
  UNIQUE KEY `QuotasLimitsID` (`QuotasLimitsID`,`TrackKey`),
  KEY `quotas_tracking_idx1` (`LastUpdate`),
  CONSTRAINT `quotas_tracking_ibfk_1` FOREIGN KEY (`QuotasLimitsID`) REFERENCES `quotas_limits` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `session_tracking`
--

DROP TABLE IF EXISTS `session_tracking`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `session_tracking` (
  `Instance` varchar(255) DEFAULT NULL,
  `QueueID` varchar(255) DEFAULT NULL,
  `UnixTimestamp` bigint(20) NOT NULL,
  `ClientAddress` varchar(64) DEFAULT NULL,
  `ClientName` varchar(255) DEFAULT NULL,
  `ClientReverseName` varchar(255) DEFAULT NULL,
  `Protocol` varchar(255) DEFAULT NULL,
  `EncryptionProtocol` varchar(255) DEFAULT NULL,
  `EncryptionCipher` varchar(255) DEFAULT NULL,
  `EncryptionKeySize` varchar(255) DEFAULT NULL,
  `SASLMethod` varchar(255) DEFAULT NULL,
  `SASLSender` varchar(255) DEFAULT NULL,
  `SASLUsername` varchar(255) DEFAULT NULL,
  `Helo` varchar(255) DEFAULT NULL,
  `Sender` varchar(255) DEFAULT NULL,
  `Size` bigint(20) unsigned DEFAULT NULL,
  `RecipientData` text DEFAULT NULL,
  UNIQUE KEY `Instance` (`Instance`),
  KEY `session_tracking_idx1` (`QueueID`,`ClientAddress`,`Sender`),
  KEY `session_tracking_idx2` (`UnixTimestamp`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping routines for database 'postfix_policyd'
--
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed
